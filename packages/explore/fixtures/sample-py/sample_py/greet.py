"""Public greeting helpers used by the LSP smoke fixture."""


def greet(name: str, shout: bool = False) -> str:
    """Return a greeting for ``name``; upper-case it when ``shout`` is true."""
    message = f"hello, {name}"
    return message.upper() if shout else message


class Greeter:
    """Greets with a fixed punctuation mark."""

    def __init__(self, mark: str = "!") -> None:
        self.mark = mark

    def greet(self, name: str) -> str:
        return greet(name) + self.mark
