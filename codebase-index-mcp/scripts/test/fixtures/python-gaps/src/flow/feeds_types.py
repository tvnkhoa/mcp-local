"""ISSUE-128 leftover 6: a small hierarchy for signature fit (Food > Meat > Steak; Stone unrelated)."""


class Food:
    pass


class Meat(Food):
    pass


class Steak(Meat):
    pass


class Stone:
    pass
