from .classcall import Holder, Switch
from .lights import Lamp, Led


class BlinkSwitch(Switch):
    """A Switch that itself has a blink(): the explicit `self` of a class call must not type `light`."""

    def blink(self) -> None:
        pass


def by_class() -> None:
    Switch.flip(BlinkSwitch(), Lamp())
    Switch.flip_static(Led())
    Switch.flip_cls(Lamp())


def build() -> Holder:
    return Holder(Led())
