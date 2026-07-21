from dataclasses import dataclass
from datetime import datetime


@dataclass
class ThemeSample:
    name: str
    enabled: bool = True


def describe(sample: ThemeSample) -> str:
    timestamp = datetime.now().isoformat()
    return f"{sample.name}\n{timestamp}\tready"


print(describe(ThemeSample(name="kiron-light")))
