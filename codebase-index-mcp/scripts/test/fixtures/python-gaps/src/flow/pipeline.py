from .ports import Executor


def drive(executor: Executor) -> str:
    return executor.run("x")


def shutdown(executor: Executor) -> None:
    """Executor.close beside Store.close in ports.py: the Protocol's own member, by owner."""
    executor.close()
