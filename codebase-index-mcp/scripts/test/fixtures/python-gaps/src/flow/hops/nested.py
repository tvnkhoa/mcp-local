"""ISSUE-128 leftover: `Outer.Inner(x)` constructs the nested class, so Inner.__init__ has a caller."""
from .lights import Lamp, Led


class Outer:
    class Inner:
        def __init__(self, light):
            light.blink()


class Other:
    class Inner:
        """Same name, second in the file: a same-file bind by bare name would pick Outer.Inner."""

        def __init__(self, light):
            light.blink()


def build_outer() -> Outer.Inner:
    return Outer.Inner(Led())


def build_other() -> Other.Inner:
    return Other.Inner(Lamp())
