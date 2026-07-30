#!/usr/bin/env python3

import sys
from pathlib import Path

from PIL import Image


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: make_icns.py INPUT.png OUTPUT.icns")

    source = Path(sys.argv[1])
    output = Path(sys.argv[2])
    image = Image.open(source).convert("RGBA")

    if image.width != image.height:
        raise SystemExit("app icon source must be square")

    image.save(output, format="ICNS")


if __name__ == "__main__":
    main()
