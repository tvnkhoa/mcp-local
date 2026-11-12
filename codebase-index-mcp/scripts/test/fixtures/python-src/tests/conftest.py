import pytest

from shop.models import Item


@pytest.fixture
def sample_item():
    return Item(name="a", cents=5)
