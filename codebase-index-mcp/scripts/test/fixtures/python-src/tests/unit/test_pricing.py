from shop.pricing import price_of


def test_price_of(sample_item):
    assert price_of(sample_item) == 4
