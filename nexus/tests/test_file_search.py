from desktop.file_search import find_document


def test_finds_file_by_exact_name(tmp_path):
    target = tmp_path / "resume.docx"
    target.write_text("hello")
    matches = find_document("resume.docx", root=str(tmp_path))
    assert str(target) in matches


def test_finds_file_by_partial_name(tmp_path):
    target = tmp_path / "my_resume_final.docx"
    target.write_text("hello")
    matches = find_document("resume", root=str(tmp_path))
    assert str(target) in matches


def test_skips_noisy_directories(tmp_path):
    noisy = tmp_path / "node_modules"
    noisy.mkdir()
    (noisy / "resume.docx").write_text("should not be found")
    matches = find_document("resume", root=str(tmp_path))
    assert matches == []


def test_no_match_returns_empty_list(tmp_path):
    matches = find_document("does-not-exist-anywhere", root=str(tmp_path))
    assert matches == []


def test_searches_nested_subfolders(tmp_path):
    nested = tmp_path / "Documents" / "2024"
    nested.mkdir(parents=True)
    target = nested / "notes.txt"
    target.write_text("hello")
    matches = find_document("notes.txt", root=str(tmp_path))
    assert str(target) in matches
