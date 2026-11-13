def test_runs(stage):
    """Fixture-only: no import of the code under test, no name in common with it."""
    assert stage.run(" x ") == "x"
