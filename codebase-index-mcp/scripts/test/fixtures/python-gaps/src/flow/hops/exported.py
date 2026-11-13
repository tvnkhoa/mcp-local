"""Review #5: __all__ grown by extend / append."""
__all__ = ["one"]
__all__.extend(["two"])
__all__.append("three")


def one() -> int:
    return 1


def two() -> int:
    return 2


def three() -> int:
    return 3
