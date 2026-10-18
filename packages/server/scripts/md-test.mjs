// Headless unit tests for the md-render section of public/app.js.
// The section between the `md-render` markers is DOM-free by contract; this
// script extracts it, evaluates it, and asserts the rendered HTML.
// Run: npm run mdtest
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appPath = path.join(here, "..", "public", "app.js");
const src = fs.readFileSync(appPath, "utf8");
const begin = src.indexOf("// ---- md-render");
const end = src.indexOf("// ---- end md-render ----");
if (begin < 0 || end < 0) {
  console.error("FAIL: md-render markers missing in app.js (keep them!)");
  process.exit(1);
}
const section = src.slice(begin, end);
const mdRender = new Function(`${section}; return mdRender;`)();

let pass = 0;
let fail = 0;
function eq(name, got, want) {
  if (got === want) {
    pass += 1;
  } else {
    fail += 1;
    console.error(`FAIL ${name}\n  got : ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
  }
}
function has(name, got, sub) {
  eq(name, got.includes(sub) ? "has" : `missing ${JSON.stringify(sub)} in ${JSON.stringify(got)}`, "has");
}

// 1) plain paragraph
eq("paragraph", mdRender("hello"), "<p>hello</p>");
// 2) soft line breaks join with <br>
eq("soft break", mdRender("a\nb"), "<p>a<br>b</p>");
// 3) blank line splits paragraphs
eq("two paragraphs", mdRender("a\n\nb"), "<p>a</p><p>b</p>");
// 4) headings map # -> h3 .. ###### -> h5
eq("h1 -> h3", mdRender("# Title"), "<h3>Title</h3>");
eq("h3 -> h5", mdRender("### Sub"), "<h5>Sub</h5>");
eq("h6 capped h5", mdRender("###### Deep"), "<h5>Deep</h5>");
// 5) inline: bold / italic / code span
eq("bold", mdRender("**bold**"), "<p><strong>bold</strong></p>");
eq("italic", mdRender("say *hi* now"), "<p>say <em>hi</em> now</p>");
eq("code span", mdRender("use `npm test` ok"), "<p>use <code>npm test</code> ok</p>");
// 6) links: only http(s), new tab
eq("link", mdRender("[x](https://e.io/a)"), '<p><a href="https://e.io/a" target="_blank" rel="noreferrer noopener">x</a></p>');
eq("javascript link neutralised", mdRender("[x](javascript:alert(1))"), "<p>[x](javascript:alert(1))</p>");
// 7) escaping: raw HTML never passes through
eq("escape html", mdRender("<script>alert(1)</script>"), "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
eq("escape quotes", mdRender('say "hi" & \'bye\''), "<p>say &quot;hi&quot; &amp; &#39;bye&#39;</p>");
// 8) fenced code block with copy button (icon, not text)
{
  const out = mdRender("```js\nconst a = 1;\n```");
  has("fence lang", out, '<span class="lang">js</span>');
  has("fence copy icon", out, '<button class="code-copy" type="button" title="copy">⧉</button>');
  has("fence content escaped", out, "const a = 1;");
  has("fence no expand", out, '<div class="codeblock">');
}
// 9) long fence collapses with expand button
{
  const long = "```\n" + Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n") + "\n```";
  const out = mdRender(long);
  has("long collapsed", out, '<div class="codeblock collapsed">');
  has("long expand btn", out, 'class="code-expand"');
}
// 10) unterminated fence still renders
has("unterminated fence", mdRender("```\nabc"), "abc");
// 11) lists
eq("ul", mdRender("- a\n- b"), "<ul><li>a</li><li>b</li></ul>");
eq("ol", mdRender("1. a\n2. b"), "<ol><li>a</li><li>b</li></ol>");
eq("list switch", mdRender("- a\n\n1. b"), "<ul><li>a</li></ul><ol><li>b</li></ol>");
// 12) blockquote + hr
eq("quote", mdRender("> quoted"), "<blockquote>quoted</blockquote>");
eq("hr", mdRender("---"), "<hr>");
// 13) CRLF normalised
eq("crlf", mdRender("a\r\nb"), "<p>a<br>b</p>");
// 14) empty input
eq("empty", mdRender(""), "");
eq("null-safe", mdRender(null), "");
// 15) inline code protects markdown chars inside
eq("code protects", mdRender("`**x**`"), "<p><code>**x**</code></p>");

// 16) GFM tables
eq(
  "table basic",
  mdRender("| Date | Sky |\n| --- | --- |\n| 10/20 | rain |"),
  '<table><thead><tr><th>Date</th><th>Sky</th></tr></thead><tbody><tr><td>10/20</td><td>rain</td></tr></tbody></table>',
);
eq(
  "table alignment",
  mdRender("| L | C | R |\n| :--- | :---: | ---: |\n| a | b | c |"),
  '<table><thead><tr><th style="text-align:left">L</th><th style="text-align:center">C</th><th style="text-align:right">R</th></tr></thead><tbody><tr><td style="text-align:left">a</td><td style="text-align:center">b</td><td style="text-align:right">c</td></tr></tbody></table>',
);
eq(
  "table without outer pipes",
  mdRender("a | b\n--- | ---\n1 | 2"),
  "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
);
eq(
  "table keeps paragraphs around it",
  mdRender("intro\n\n| a |\n| --- |\n| 1 |\n\nafter"),
  "<p>intro</p><table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table><p>after</p>",
);
eq(
  "table absent without separator",
  mdRender("| a | b |\n| 1 | 2 |"),
  "<p>| a | b |<br>| 1 | 2 |</p>",
);
eq(
  "table cells escape html + inline md",
  mdRender("| x |\n| --- |\n| **b** <i> |"),
  '<table><thead><tr><th>x</th></tr></thead><tbody><tr><td><strong>b</strong> &lt;i&gt;</td></tr></tbody></table>',
);
eq("hr still works next to tables", mdRender("---"), "<hr>");

console.log(`md-render: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
