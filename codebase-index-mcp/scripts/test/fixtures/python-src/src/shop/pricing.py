from .models import Item


def price_of(item: Item) -> int:
    return apply_discount(item.cents)


def apply_discount(cents: int) -> int:
    return cents - 1


class Calculator:
    rate: int = 2

    @staticmethod
    def zero() -> int:
        return 0

    @classmethod
    def build(cls) -> "Calculator":
        cls.zero()
        return cls()

    @property
    def doubled(self) -> int:
        return self.total(1)

    def total(self, cents: int) -> int:
        return price_of_cents(cents) * self.rate


def price_of_cents(cents: int) -> int:
    return cents
