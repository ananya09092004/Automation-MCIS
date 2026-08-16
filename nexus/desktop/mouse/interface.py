from abc import ABC, abstractmethod


class BaseMouse(ABC):

    @abstractmethod
    def move(self, x: int, y: int, duration: float = 0.3):
        pass

    @abstractmethod
    def click(self):
        pass

    @abstractmethod
    def right_click(self):
        pass

    @abstractmethod
    def double_click(self):
        pass

    @abstractmethod
    def scroll_up(self, amount: int = 500):
        pass

    @abstractmethod
    def scroll_down(self, amount: int = 500):
        pass

    @abstractmethod
    def drag_to(self, x: int, y: int, duration: float = 0.5):
        pass

    @abstractmethod
    def position(self):
        pass