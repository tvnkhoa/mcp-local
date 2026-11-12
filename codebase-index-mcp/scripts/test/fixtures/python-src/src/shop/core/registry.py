from functools import partial

from ..pricing import price_of as p, apply_discount

REGISTRY = {
    "price": p,
    "discount": partial(apply_discount, 1),
}


def lookup(name):
    return REGISTRY[name]
