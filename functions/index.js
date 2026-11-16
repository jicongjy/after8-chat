// 퇴근 후 8시 채팅 · AI 호출 함수 (Firebase Cloud Functions)
// - 클로드 키는 Secret Manager의 비밀값(ANTHROPIC_API_KEY)에서만 읽고, 브라우저로는 절대 보내지 않는다.
// - 로그인한 사용자(익명 포함)만 부를 수 있고, 운영자 지침은 Firestore에서 읽어 프롬프트에 붙인다.
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
const Anthropic = require("@anthropic-ai/sdk");

initializeApp();
const KEY = defineSecret("ANTHROPIC_API_KEY");
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const MAX_PROMPT = 40000;            // 글자 수 상한 (스토어 데이터 + 대화). 보통 질문은 이보다 훨씬 작다.
const DAILY_ANON = 30, DAILY_ADMIN = 300; // 사용자 한 명(uid)이 하루에 부를 수 있는 횟수
const TABS_OK = ["all", "t2", "t3", "t4"];
const oneLine = (s, n) => String(s || "").replace(/[\u0000-\u001f"]/g, " ").trim().slice(0, n);

async function readGL() {
  // 지침이 없는 것(빈 목록)과 읽지 못한 것(오류)을 구분한다. 읽지 못하면 호출한 쪽에서 막는다.
  const d = await getFirestore().doc("config/guidelines").get();
  const items = d.exists && Array.isArray(d.data().items) ? d.data().items : [];
  return items.slice(0, 50).map(x => ({ tab: TABS_OK.includes(x.tab) ? x.tab : "all", rule: oneLine(x.rule, 300), ex: oneLine(x.ex, 80), on: x.on !== false })).filter(x => x.rule);
}
// 하루 사용 횟수를 uid별로 센다. 한도를 넘으면 false.
async function useQuota(uid, limit) {
  const day = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); // 한국 날짜 기준
  const ref = getFirestore().doc(`usage/${uid}_${day}`);
  return getFirestore().runTransaction(async t => {
    const n = ((await t.get(ref)).data() || {}).n || 0;
    if (n >= limit) return false;
    t.set(ref, { uid, day, n: n + 1, at: Date.now() });
    return true;
  });
}
function glText(items, tab) {
  const a = items.filter(x => x.on && (x.tab === "all" || x.tab === tab)).slice(0, 30);
  if (!a.length) return { n: 0, text: "" };
  return { n: a.length, text: "[운영자 피드백 지침]\n아래는 운영자가 실제 대화를 검토하고 남긴 지침이야. 위 답변 규칙과 함께 반드시 지키고, 충돌하면 이 지침을 우선해.\n" + a.map((x, i) => `${i + 1}. ${x.rule}${x.ex ? ` (참고 질문: "${x.ex}")` : ""}`).join("\n") };
}
function withGL(prompt, text) {
  const mark = "\n\n[지금까지의 대화]\n", i = prompt.indexOf(mark);
  return i < 0 ? text + "\n\n" + prompt : prompt.slice(0, i) + "\n\n" + text + prompt.slice(i);
}
const fail = (res, code, c, message) => res.status(code).json({ code: c, message });

exports.chat = onRequest({ region: "asia-northeast3", secrets: [KEY], maxInstances: 3, timeoutSeconds: 60, memory: "256MiB", cors: false }, async (req, res) => {
  if (req.method !== "POST") return fail(res, 405, "bad_request", "POST 로만 쓸 수 있어요.");
  const m = /^Bearer (.+)$/.exec(req.get("Authorization") || "");
  if (!m) return fail(res, 401, "no_login", "로그인이 필요해요. 새로고침 후 다시 시도해 주세요.");
  let user;
  try { user = await getAuth().verifyIdToken(m[1]); } catch (e) { return fail(res, 401, "no_login", "로그인이 필요해요. 새로고침 후 다시 시도해 주세요."); }

  const b = req.body || {}, prompt = b.prompt, tab = typeof b.tab === "string" ? b.tab : "";
  if (typeof prompt !== "string" || !prompt.trim()) return fail(res, 400, "bad_request", "질문이 비어 있어요.");
  if (prompt.length > MAX_PROMPT) return fail(res, 413, "too_large", "대화가 너무 길어요. 새로 시작해 주세요.");

  let items;
  try { items = await readGL(); } catch (e) { console.error("[지침 읽기 실패]", e && e.name); return fail(res, 503, "failed", "잠시 문제가 생겼어요. 조금 뒤에 다시 시도해 주세요."); }
  try {
    const anon = user.firebase && user.firebase.sign_in_provider === "anonymous";
    if (!(await useQuota(user.uid, anon ? DAILY_ANON : DAILY_ADMIN))) return fail(res, 429, "rate_limited", "오늘 쓸 수 있는 AI 답변 횟수를 다 썼어요. 내일 다시 이용해 주세요.");
  } catch (e) { console.error("[사용량 확인 실패]", e && e.name); return fail(res, 503, "failed", "잠시 문제가 생겼어요. 조금 뒤에 다시 시도해 주세요."); }
  const gl = glText(items, tab);
  const params = { model: MODEL, max_tokens: 1024, messages: [{ role: "user", content: gl.n ? withGL(prompt, gl.text) : prompt }] };
  if (/opus/.test(MODEL)) params.output_config = { effort: "low" };

  let started = false;
  const ac = new AbortController();
  res.on("close", () => ac.abort()); // 사용자가 화면을 닫으면 호출 중단
  try {
    const client = new Anthropic({ apiKey: KEY.value().trim() });
    const stream = client.messages.stream(params, { signal: ac.signal });
    for await (const ev of stream) {
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
        if (!started) { res.set({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no", "X-Guidelines": String(gl.n) }); started = true; }
        res.write(ev.delta.text);
      }
    }
    if (!started) res.set({ "Content-Type": "text/plain; charset=utf-8", "X-Guidelines": String(gl.n) });
    res.end();
  } catch (e) {
    if (ac.signal.aborted) return;
    const status = e && e.status;
    console.error("[AI 호출 실패]", status || "", e && e.name); // 키는 로그에 남기지 않는다
    if (started) return res.end();
    const info = status === 401 ? ["bad_key", "API 키가 올바르지 않아요. 운영자에게 알려 주세요."]
      : status === 404 ? ["bad_model", "모델 이름을 찾을 수 없어요. 운영자에게 알려 주세요."]
      : status === 429 ? ["rate_limited", "요청이 많아요. 잠시 뒤에 다시 보내 주세요."]
      : ["failed", "AI 호출에 실패했어요. 잠시 뒤에 다시 시도해 주세요."];
    fail(res, status && status < 600 ? status : 502, info[0], info[1]);
  }
});
