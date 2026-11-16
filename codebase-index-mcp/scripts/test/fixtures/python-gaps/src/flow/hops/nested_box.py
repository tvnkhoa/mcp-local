"""ISSUE-128: a nested class constructed from ANOTHER file (nested_use.py imports Box)."""


class Box:
    class Item:
        def __init__(self, light):
            light.blink()
