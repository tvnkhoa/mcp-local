def normalize(text: str) -> str:
    return text.strip()


class Formatter:
    @staticmethod
    def check(text: str) -> bool:
        return bool(text)


def _private() -> None:
    pass


def slugify(text: str) -> str:
    """PY-8b: api.py imports this but leaves it out of __all__."""
    return text.lower()
