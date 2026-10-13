"""Conservative browser recovery; it never submits, pays, or accepts permissions."""

from dataclasses import dataclass, field


@dataclass
class RecoveryReport:
    recovered: bool
    steps: list[str] = field(default_factory=list)


class BrowserRecovery:
    def recover(self, page) -> RecoveryReport:
        steps = []
        if page.is_closed():
            return RecoveryReport(False, ["page_closed"])
        try:
            page.wait_for_load_state("domcontentloaded", timeout=5000)
            steps.append("waited_for_dom")
        except Exception:
            steps.append("dom_wait_failed")
        # Only dismiss explicitly-labelled close/cancel controls; never accept consent/permissions.
        for label in ("Close", "Cancel", "Dismiss"):
            try:
                button = page.get_by_role("button", name=label, exact=True)
                if button.count() and button.first.is_visible():
                    button.first.click()
                    steps.append(f"dismissed_{label.lower()}")
                    break
            except Exception:
                continue
        return RecoveryReport("waited_for_dom" in steps, steps)
