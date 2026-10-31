"""APFS clone-only export. No fallback full copy, links are never followed."""
import ctypes
import json
import os
import stat
import sys

library = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
clonefile = library.clonefile
clonefile.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int]
clonefile.restype = ctypes.c_int
count = 0


def clone(source, destination):
    global count
    parent = os.path.dirname(destination)
    os.makedirs(parent, exist_ok=True)
    if os.path.realpath(parent) != parent:
        raise ValueError("Y5_CLONE_DESTINATION_PARENT_ALIAS")
    mode = os.lstat(source).st_mode
    if stat.S_ISLNK(mode):
        os.symlink(os.readlink(source), destination)
    elif stat.S_ISDIR(mode):
        if os.path.lexists(destination) and (
            not stat.S_ISDIR(os.lstat(destination).st_mode) or os.listdir(destination)
        ):
            raise ValueError("Y5_CLONE_NEW_OR_EMPTY_DIRECTORY_REQUIRED")
        os.makedirs(destination, exist_ok=True)
        with os.scandir(source) as entries:
            for entry in sorted(entries, key=lambda item: item.name):
                clone(entry.path, os.path.join(destination, entry.name))
    elif stat.S_ISREG(mode):
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        if clonefile(os.fsencode(source), os.fsencode(destination), 0) != 0:
            number = ctypes.get_errno()
            raise OSError(number, "Y5_APFS_CLONE_REQUIRED: " + os.strerror(number), source)
        count += 1
    else:
        raise ValueError("Y5_UNSUPPORTED_CLONE_ASSET")


pairs = json.load(sys.stdin)
if not isinstance(pairs, list) or len(pairs) > 100000:
    raise ValueError("Y5_CLONE_MANIFEST_BOUND")
for pair in pairs:
    if not isinstance(pair, list) or len(pair) != 2 or not all(
        isinstance(path, str) and os.path.isabs(path) and "\0" not in path for path in pair
    ):
        raise ValueError("Y5_ABSOLUTE_CLONE_PATHS_REQUIRED")
    source, destination = pair
    if any(os.path.normpath(path) != path for path in pair) or (
        os.path.commonpath([os.path.realpath(source), destination]) in (os.path.realpath(source), destination)
    ):
        raise ValueError("Y5_CLONE_SEPARATE_CANONICAL_PATHS_REQUIRED")
    clone(*pair)
print(json.dumps({"stage": "APFS_CLONE_ONLY", "files": count}))
