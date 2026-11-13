from .helpers.api import *


def use(text: str) -> str:
    Formatter.check(text)
    return normalize(text)
