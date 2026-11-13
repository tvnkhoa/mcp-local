"""Decoys: same names, sorting before helpers/; the star import must not land here."""


def normalize(text: str) -> str:
    return text


class Formatter:
    @staticmethod
    def check(text: str) -> bool:
        return False


def slugify(text: str) -> str:
    return text


def shown() -> int:
    return 2


def _hidden() -> int:
    return 3


def _private() -> None:
    pass
