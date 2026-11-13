import pytest


@pytest.fixture
def stage():
    """A sibling subtree: never the fixture of a test in tests/unit/."""
    return None
