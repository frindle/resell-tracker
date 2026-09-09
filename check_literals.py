
"""Assert every `## Must contain` literal from TASK.md is in the target.

ADDITIONAL to the behavioural cases, never a replacement: a literal check is a
proxy and passes on a file that contains the right text and does the wrong
thing. But a verify asserting NO spec literal cannot tell a correct
implementation from an inverted one -- a whole literal cannot match its own
negation. So: both.

LITERALS is written here VERBATIM by `ollama-dispatch-scaffold --freeze-literals`
rather than read from TASK.md at run time. A dynamic read is better engineering
and worse evidence: the literal never appears in the verify text, so a grader
scanning the verify cannot see that it is asserted, and verify-quality.py
correctly reported "the verify asserts none of them". The drift guard below is
what makes a second copy safe -- two records of one fact drift, always.
"""
import pathlib
import re
import sys

TARGET = pathlib.Path('app/api/bfmr/links/route.ts')

# frozen from TASK.md -- re-run `ollama-dispatch-scaffold --freeze-literals .`
LITERALS = []

task = pathlib.Path("TASK.md").read_text()
m = re.search(r"##+\s*Must contain[^\n]*\n(.*?)(?=\n##\s|\Z)", task, re.S | re.I)
current = [b.group(1) for b in re.finditer(r"`([^`\n]{1,200})`", m.group(1))] if m else []
current = [l for l in current if "TODO" not in l]

if not LITERALS:
    print("  no frozen literals -- run: ollama-dispatch-scaffold "
          "--freeze-literals .")
    sys.exit(1)
if LITERALS != current:
    print("  literals DRIFTED from TASK.md -- re-run --freeze-literals")
    print("    frozen : {!r}".format(LITERALS))
    print("    TASK.md: {!r}".format(current))
    sys.exit(1)

body = TARGET.read_text() if TARGET.is_file() else ""
missing = [l for l in LITERALS if l not in body]
for l in missing:
    print("  MISSING literal in {}: {!r}".format(TARGET, l))
print("  {}/{} literal(s) present".format(len(LITERALS) - len(missing), len(LITERALS)))
sys.exit(1 if missing else 0)
