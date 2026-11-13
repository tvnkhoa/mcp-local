from .helpers.api import *
from .helpers.plain import *


def use_plain() -> int:
    slugify("x")
    _private()
    _hidden()
    return shown()
