import pytest

from flow.stages.fix import FixStage


@pytest.fixture
def stage():
    return FixStage()
