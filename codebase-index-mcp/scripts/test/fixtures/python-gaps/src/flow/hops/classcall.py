"""Row #16 item 1: class calls type untyped parameters (callers in use_classcall.py)."""


class Switch:
    def flip(self, light):
        light.blink()

    @staticmethod
    def flip_static(light):
        light.blink()

    @classmethod
    def flip_cls(cls, light):
        light.blink()
