"""Row #16 items 1-2: class calls and constructor arguments type untyped parameters (callers in use_classcall.py)."""


class Switch:
    def flip(self, light):
        light.blink()

    @staticmethod
    def flip_static(light):
        light.blink()

    @classmethod
    def flip_cls(cls, light):
        light.blink()


class Holder:
    def __init__(self, light):
        light.blink()
        self.light = light

    def later(self):
        self.light.blink()


class Bare:
    """Negative control: no caller constructs it with a typed argument."""

    def __init__(self, light):
        self.light = light

    def later(self):
        self.light.blink()


class Gen:
    def flip_gen[T](self, light: T | None = None, other=None):
        """Review: a PEP 695 type-parameter list before the parameters; `other` is untyped."""
        other.blink()

