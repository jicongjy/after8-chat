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
const MAX_PROMPT = 120000;
const TABS_OK = ["all", "t2", "t3", "t4"];
const oneLine = (s, n) => String(s || "").replace(/[\u0000-\u001f"]/g, " ").trim().slice(0, n);

async function readGL() {
  try {
    const d = await getFirestore().doc("config/guidelines").get();
    const items = d.exists && Array.isArray(d.data().items) ? d.data().items : [];
    return items.slice(0, 50).map(x => ({ tab: TABS_OK.includes(x.tab) ? x.tab : "all", rule: oneLine(x.rule, 300), ex: oneLine(x.ex, 80), on: x.on !== false })).filter(x => x.rule);
  } catch (e) { return []; }
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
  try { await getAuth().verifyIdToken(m[1]); } catch (e) { return fail(res, 401, "no_login", "로그인이 필요해요. 새로고침 후 다시 시도해 주세요."); }

  const b = req.body || {}, prompt = b.prompt, tab = typeof b.tab === "string" ? b.tab : "";
  if (typeof prompt !== "string" || !prompt.trim()) return fail(res, 400, "bad_request", "질문이 비어 있어요.");
  if (prompt.length > MAX_PROMPT) return fail(res, 413, "too_large", "대화가 너무 길어요. 새로 시작해 주세요.");

  const gl = glText(await readGL(), tab);
  const params = { model: MODEL, max_tokens: 1024, messages: [{ role: "user", content: gl.n ? withGL(prompt, gl.text) : prompt }] };
  if (/opus/.test(MODEL)) params.output_config = { effort: "low" };

  let started = false;
  try {
    const client = new Anthropic({ apiKey: KEY.value().trim() });
    const stream = client.messages.stream(params);
    for await (const ev of stream) {
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
        if (!started) { res.set({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no", "X-Guidelines": String(gl.n) }); started = true; }
        res.write(ev.delta.text);
      }
    }
    if (!started) res.set({ "Content-Type": "text/plain; charset=utf-8", "X-Guidelines": String(gl.n) });
    res.end();
  } catch (e) {
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
