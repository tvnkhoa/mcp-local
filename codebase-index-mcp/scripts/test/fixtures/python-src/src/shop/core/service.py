import shop.pricing as pr
from shop import price_of
from shop.models import Base
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from shop.models import Item
    from shop.pricing import Calculator


class Service(Base):
    def __init__(self, calc: "Calculator") -> None:
        super().__init__("svc")
        self.calc = calc

    def run(self, item: "Item") -> int:
        self.helper()
        Service.make()
        total = self.calc.total(item.cents)
        return pr.price_of(item) + price_of(item) + total

    def helper(self) -> str:
        return super().describe()

    @classmethod
    def make(cls) -> "Service":
        return cls.create()

    @classmethod
    def create(cls) -> "Service":
        return cls(None)


def summarize(calc: "Calculator") -> int:
    return calc.total(3)
