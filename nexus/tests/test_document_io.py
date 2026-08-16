"""Round-trip tests for the universal document reader/writer.

These write real temp files and read them back -- no mocking needed,
since these are just format-conversion functions.
"""
from desktop.document_io import read_document, write_document


def test_txt_round_trip(tmp_path):
    path = tmp_path / "notes.txt"
    write_document(str(path), "line one\nline two")
    assert read_document(str(path)) == "line one\nline two"


def test_docx_round_trip(tmp_path):
    path = tmp_path / "resume.docx"
    write_document(str(path), "Experience\nBuilt an execution engine.")
    content = read_document(str(path))
    assert "Experience" in content
    assert "Built an execution engine." in content


def test_xlsx_round_trip(tmp_path):
    path = tmp_path / "data.xlsx"
    write_document(str(path), "name,score\nAnushka,10")
    content = read_document(str(path))
    assert "name" in content
    assert "Anushka" in content


def test_unsupported_extension_raises(tmp_path):
    path = tmp_path / "file.xyz"
    try:
        read_document(str(path))
        assert False, "expected ValueError"
    except ValueError as error:
        assert "Unsupported" in str(error)
