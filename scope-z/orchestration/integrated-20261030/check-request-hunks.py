#!/usr/bin/env python3
"""Check that a phase's shared-file integration request is carried by the integrated tree.

A request ships a unified patch computed against the pre-Z base. The integrated tree also carries the
other phases' edits to the same shared files, so byte equality with the request's postimage is the wrong
test (and reverse-applying the patch fails whenever another phase touched a nearby line). The right test
is per hunk: every contiguous block the request adds must be present in the integrated file, and every
contiguous block the request removes must be absent. Lines are compared with all whitespace removed, so a
formatting difference that does not change the token stream (for example `{ X }` against `{X}`) is not a
difference.

usage: check-request-hunks.py PATCH [--root DIR]
exit 0: every block accounted for; exit 1: at least one block missing or still present; exit 2: bad input.
"""
import re
import sys
from pathlib import Path


def squash(line: str) -> str:
    return re.sub(r"\s+", "", line)


def parse(patch: str):
    files, current = {}, None
    lines = patch.split("\n")
    index = 0
    while index < len(lines):
        line = lines[index]
        header = re.match(r"diff --git a/(.*) b/(.*)", line)
        if header:
            current = header.group(2)
            files[current] = []
            index += 1
            continue
        if line.startswith("@@") and current is not None:
            blocks, added, removed = [], [], []
            index += 1
            while index < len(lines) and not lines[index].startswith("@@") and not lines[index].startswith("diff --git "):
                text = lines[index]
                if text.startswith("+") and not text.startswith("+++"):
                    if removed:
                        blocks.append(("remove", removed))
                        removed = []
                    added.append(text[1:])
                elif text.startswith("-") and not text.startswith("---"):
                    if added:
                        blocks.append(("add", added))
                        added = []
                    removed.append(text[1:])
                else:
                    if added:
                        blocks.append(("add", added))
                        added = []
                    if removed:
                        blocks.append(("remove", removed))
                        removed = []
                index += 1
            if added:
                blocks.append(("add", added))
            if removed:
                blocks.append(("remove", removed))
            files[current].append(blocks)
            continue
        index += 1
    return files


def contains(haystack, needle):
    width = len(needle)
    return any(haystack[start:start + width] == needle for start in range(len(haystack) - width + 1))


def main() -> int:
    arguments = sys.argv[1:]
    if not arguments or arguments[0].startswith("-"):
        print(__doc__)
        return 2
    patch_path = Path(arguments[0])
    root = Path(arguments[arguments.index("--root") + 1]) if "--root" in arguments else Path.cwd()
    try:
        files = parse(patch_path.read_text(encoding="utf8"))
    except OSError as error:
        print(f"UNREADABLE_PATCH {error}")
        return 2
    if not files:
        print("NO_FILES_IN_PATCH")
        return 2
    mismatches = 0
    for name, hunks in files.items():
        target = root / name
        if not target.is_file():
            print(f"MISSING_FILE {name}")
            mismatches += 1
            continue
        current = [squash(line) for line in target.read_text(encoding="utf8").split("\n")]
        present = absent = bad = 0
        for blocks in hunks:
            for kind, block in blocks:
                found = contains(current, [squash(line) for line in block])
                if kind == "add" and found or kind == "remove" and not found:
                    present += kind == "add"
                    absent += kind == "remove"
                else:
                    bad += 1
                    print(f"  {'ADDED_BLOCK_MISSING' if kind == 'add' else 'REMOVED_BLOCK_STILL_PRESENT'} {name}: {block[0][:100]!r}")
        mismatches += bad
        print(f"{name}: hunks={len(hunks)} added blocks present={present} removed blocks absent={absent} mismatched={bad}")
    print(f"TOTAL_MISMATCHED_BLOCKS {mismatches}")
    return 1 if mismatches else 0


if __name__ == "__main__":
    sys.exit(main())
