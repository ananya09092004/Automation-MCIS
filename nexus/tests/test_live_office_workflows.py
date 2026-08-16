"""Real, isolated Office acceptance workflows. Each uses a pytest temporary directory."""

import pytest

from desktop.capabilities.office import OfficeCapability


def _office_files_or_skip() -> OfficeCapability:
    pytest.importorskip("docx")
    pytest.importorskip("openpyxl")
    pytest.importorskip("pptx")
    return OfficeCapability()


@pytest.mark.live
def test_word_create_save_reopen_and_verify(tmp_path):
    office = _office_files_or_skip()
    path = tmp_path / "nexus-word-live.docx"
    assert office.create_word_document(str(path), "Nexus Word live workflow") == str(path)
    assert office.read_word_document(str(path)) == "Nexus Word live workflow"


@pytest.mark.live
def test_excel_create_save_reopen_and_verify(tmp_path):
    office = _office_files_or_skip()
    path = tmp_path / "nexus-excel-live.xlsx"
    rows = [["Item", "Count"], ["Nexus", 1]]
    assert office.create_excel_workbook(str(path), rows) == str(path)
    assert office.read_excel_rows(str(path)) == rows


@pytest.mark.live
def test_powerpoint_create_save_reopen_and_verify(tmp_path):
    office = _office_files_or_skip()
    path = tmp_path / "nexus-powerpoint-live.pptx"
    assert office.create_powerpoint_presentation(str(path), "Nexus", "Live workflow") == str(path)
    assert office.inspect_powerpoint_presentation(str(path))["slide_count"] == 1
