"""화면 원본(template.html)에 글꼴·답변 규칙·스토어 데이터를 끼워 web/index.html 한 파일로 만든다.
실행: python3 src/build.py
"""
import json, os
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
rd = lambda *p: open(os.path.join(ROOT, *p), encoding="utf8").read()
html = rd("src", "template.html")
import re

def js(text):
    # <script> 안에 넣을 문자열: '</script>' 같은 글이 들어 있어도 태그가 닫히지 않게 '<'를 이스케이프한다.
    return json.dumps(text, ensure_ascii=False).replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")

fonts = rd("src", "fonts.css")
if "</style" in fonts.lower():
    raise SystemExit("fonts.css 에 </style 이 들어 있어요.")
rep = {
    "__FONTS__": fonts,
    "__EV4__": js(rd("content", "tab4-info.md")),
    "__RU4__": js(rd("content", "tab4-rules.md")),
}
# 한 번에 바꿔서, 끼워 넣은 글 안의 __XX__ 가 다시 바뀌지 않게 한다.
html = re.sub("|".join(map(re.escape, rep)), lambda m: rep[m.group(0)], html)
open(os.path.join(ROOT, "web", "index.html"), "w", encoding="utf8").write(html)
print("web/index.html 을 만들었어요.")
