"""The wire boundary: camelCase keys, no `null` for an absent optional, no stray whitespace."""

from dataclasses import dataclass, field

from revgate.shared.jsonio import dumps_compact, to_camel, to_wire
from revgate.shared.types import DiffFile, DiffHunk, DiffLine, LineComment, ReviewSubmission


@dataclass(slots=True)
class Inner:
    some_value: int
    absent: str | None = None


@dataclass(slots=True)
class Outer:
    inner_thing: Inner
    many: list[Inner] = field(default_factory=list)
    missing: str | None = None


def test_to_camel_converts_snake_case() -> None:
    assert to_camel("old_path") == "oldPath"
    assert to_camel("is_new") == "isNew"
    assert to_camel("permission_decision_reason") == "permissionDecisionReason"


def test_to_camel_leaves_a_single_word_alone() -> None:
    assert to_camel("path") == "path"
    assert to_camel("hunks") == "hunks"


def test_to_wire_drops_none_rather_than_emitting_null() -> None:
    # The review page tells an absent field from a null one, so this is a
    # behaviour contract and not a cosmetic choice.
    assert to_wire(Inner(some_value=1)) == {"someValue": 1}
    assert "absent" not in to_wire(Inner(some_value=1))


def test_to_wire_keeps_a_present_falsy_value() -> None:
    # Only `None` is dropped. A 0 or an empty string is real data: `startLine`
    # is 0 on both ends for a whole-file comment.
    assert to_wire(LineComment(file="a.py", start_line=0, end_line=0, side="new", body="")) == {
        "file": "a.py",
        "startLine": 0,
        "endLine": 0,
        "side": "new",
        "body": "",
    }


def test_to_wire_recurses_through_nested_dataclasses_and_lists() -> None:
    wired = to_wire(Outer(inner_thing=Inner(1), many=[Inner(2), Inner(3, "here")]))
    assert wired == {
        "innerThing": {"someValue": 1},
        "many": [{"someValue": 2}, {"someValue": 3, "absent": "here"}],
    }


def test_to_wire_leaves_mapping_keys_verbatim() -> None:
    # These keys are data, not field names: `states` is keyed by file path, and
    # a path such as `src/my_file.py` must survive untouched.
    assert to_wire({"src/my_file.py": "yes", "a_b": "no"}) == {"src/my_file.py": "yes", "a_b": "no"}


def test_to_wire_drops_none_values_inside_a_mapping() -> None:
    assert to_wire({"kept": 1, "dropped": None}) == {"kept": 1}


def test_to_wire_does_not_explode_a_string_into_characters() -> None:
    # A str is a Sequence; without the explicit guard it would become a list.
    assert to_wire("hello") == "hello"
    assert to_wire(["a", "b"]) == ["a", "b"]


def test_to_wire_on_the_real_diff_model() -> None:
    diff_file = DiffFile(
        old_path="a.py",
        new_path="a.py",
        path="a.py",
        is_new=False,
        is_deleted=False,
        is_renamed=False,
        is_binary=False,
        additions=1,
        deletions=0,
        hunks=[
            DiffHunk(
                header="@@ -1 +1 @@",
                old_start=1,
                new_start=1,
                lines=[DiffLine(type="add", content="x", old_line=None, new_line=1)],
            )
        ],
    )
    wired = to_wire(diff_file)
    assert wired["oldPath"] == "a.py"
    assert wired["isNew"] is False
    assert "staged" not in wired, "an absent staging state must not become null"
    line = wired["hunks"][0]["lines"][0]
    assert line == {"type": "add", "content": "x", "newLine": 1}
    assert "oldLine" not in line


def test_dumps_compact_has_no_incidental_whitespace() -> None:
    assert dumps_compact({"a": 1, "b": [1, 2]}) == '{"a":1,"b":[1,2]}'


def test_dumps_compact_does_not_escape_non_ascii() -> None:
    # `JSON.stringify` emits the character itself, and the annotation output is
    # byte-compared against it.
    assert dumps_compact({"s": "héllo — ok"}) == '{"s":"héllo — ok"}'


def test_dumps_compact_ends_without_a_newline() -> None:
    assert not dumps_compact({"ok": True}).endswith("\n")


def test_a_submission_round_trips_to_the_wire_shape() -> None:
    submission = ReviewSubmission(
        decision="request_changes",
        summary="needs work",
        comments=[LineComment(file="a.py", start_line=3, end_line=4, side="new", body="why?")],
    )
    assert dumps_compact(to_wire(submission)) == (
        '{"decision":"request_changes","summary":"needs work",'
        '"comments":[{"file":"a.py","startLine":3,"endLine":4,"side":"new","body":"why?"}]}'
    )
