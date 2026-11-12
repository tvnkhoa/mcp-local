from typing import Optional

from .pricing import Calculator


class Zeta:
    def run(self) -> str:
        return "z"


class Alpha:
    def run(self) -> str:
        return "a"


class ZetaFirst(Zeta, Alpha):
    def go(self, calc: Optional[Calculator]) -> str:
        calc.total(1)
        return self.run()


class AlphaFirst(Alpha, Zeta):
    def go(self, items: list[Calculator]) -> str:
        items.append(None)
        return self.run()
