"""화면 원본(template.html)에 글꼴·답변 규칙·스토어 데이터를 끼워 web/index.html 한 파일로 만든다.
실행: python3 src/build.py
"""
import json, os
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
rd = lambda *p: open(os.path.join(ROOT, *p), encoding="utf8").read()
html = rd("src", "template.html")
rep = {
    "__FONTS__": rd("src", "fonts.css"),
    "__EV__": json.dumps(rd("content", "event-info.md"), ensure_ascii=False),
    "__RU__": json.dumps(rd("content", "answer-rules.md"), ensure_ascii=False),
    "__EV4__": json.dumps(rd("content", "tab4-info.md"), ensure_ascii=False),
    "__RU4__": json.dumps(rd("content", "tab4-rules.md"), ensure_ascii=False),
}
for k, v in rep.items():
    html = html.replace(k, v)
open(os.path.join(ROOT, "web", "index.html"), "w", encoding="utf8").write(html)
print("web/index.html 을 만들었어요.")
