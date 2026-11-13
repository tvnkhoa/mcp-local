import pytest

from flow.stages.draft import DraftStage


@pytest.fixture
def stage():
    """Overridden by tests/unit/conftest.py for tests under tests/unit/."""
    return DraftStage()
