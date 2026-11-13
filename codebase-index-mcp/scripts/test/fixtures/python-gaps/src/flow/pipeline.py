from .ports import Executor


def drive(executor: Executor) -> str:
    return executor.run("x")
