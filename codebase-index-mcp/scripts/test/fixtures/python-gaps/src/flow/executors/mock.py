class MockExecutor:
    """Structural: no base at all."""

    def run(self, job: str) -> str:
        return "mock"

    def close(self) -> None:
        pass
