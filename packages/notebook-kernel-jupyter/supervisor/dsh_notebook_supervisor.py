#!/usr/bin/env python3
"""Notebook supervisor speaking newline-delimited JSON RPC over stdio."""

from __future__ import annotations

import base64
import code
import io
import json
import math
import os
import queue
import subprocess
import sys
import time
from types import CodeType
from typing import Any


class SupervisorError(Exception):
    """Failure with a stable code for the TypeScript provider."""

    def __init__(self, code: str, message: str, details: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = details


class OutputLimitError(Exception):
    """One operation exceeded its configured UTF-8 output budget."""


class WireLimitError(Exception):
    """One JSON response exceeded its configured UTF-8 byte budget."""


def json_string_size(value: str, budget: int) -> int:
    if len(value) + 2 > budget:
        raise WireLimitError
    size = 2
    for char in value:
        codepoint = ord(char)
        if char in ('"', "\\", "\b", "\t", "\n", "\f", "\r"):
            size += 2
        elif codepoint < 0x20:
            size += 6
        elif codepoint <= 0x7F:
            size += 1
        elif codepoint <= 0x7FF:
            size += 2
        elif 0xD800 <= codepoint <= 0xDFFF:
            raise TypeError("unpaired surrogate is not lossless UTF-8 JSON")
        elif codepoint <= 0xFFFF:
            size += 3
        else:
            size += 4
        if size > budget:
            raise WireLimitError
    return size


def json_size(value: Any, budget: int, active: set[int] | None = None) -> int:
    if budget < 0:
        raise WireLimitError
    if value is None:
        size = 4
    elif value is True:
        size = 4
    elif value is False:
        size = 5
    elif isinstance(value, str):
        return json_string_size(value, budget)
    elif isinstance(value, int):
        size = len(str(value))
    elif isinstance(value, float):
        if not math.isfinite(value):
            raise TypeError("non-finite float is not lossless JSON")
        size = len(json.dumps(value, allow_nan=False))
    elif isinstance(value, (list, tuple)):
        seen = active if active is not None else set()
        marker = id(value)
        if marker in seen:
            raise TypeError("circular value is not JSON")
        seen.add(marker)
        size = 2
        for index, item in enumerate(value):
            if index:
                size += 1
            size += json_size(item, budget - size, seen)
            if size > budget:
                seen.remove(marker)
                raise WireLimitError
        seen.remove(marker)
    elif isinstance(value, dict):
        seen = active if active is not None else set()
        marker = id(value)
        if marker in seen:
            raise TypeError("circular value is not JSON")
        seen.add(marker)
        size = 2
        for index, (key, item) in enumerate(value.items()):
            if not isinstance(key, str):
                seen.remove(marker)
                raise TypeError("JSON object keys must be strings")
            if index:
                size += 1
            size += json_string_size(key, budget - size) + 1
            size += json_size(item, budget - size, seen)
            if size > budget:
                seen.remove(marker)
                raise WireLimitError
        seen.remove(marker)
    else:
        raise TypeError(f"{type(value).__name__} is not lossless JSON")
    if size > budget:
        raise WireLimitError
    return size


def utf8_size(value: str, budget: int) -> int:
    if len(value) > budget:
        raise WireLimitError
    size = 0
    for char in value:
        codepoint = ord(char)
        if codepoint <= 0x7F:
            size += 1
        elif codepoint <= 0x7FF:
            size += 2
        elif 0xD800 <= codepoint <= 0xDFFF:
            raise TypeError("unpaired surrogate is not valid UTF-8")
        elif codepoint <= 0xFFFF:
            size += 3
        else:
            size += 4
        if size > budget:
            raise WireLimitError
    return size


class MutationLedger:
    """Ordered kernel mutations retained within one exact JSON byte budget."""

    def __init__(self, max_bytes: int) -> None:
        self.max_bytes = max_bytes
        self.bytes_used = 2
        self.mutations: list[dict[str, Any]] = []

    def add(self, mutation: dict[str, Any]) -> None:
        try:
            item_bytes = json_size(mutation, self.max_bytes)
        except WireLimitError as error:
            raise OutputLimitError(
                f"cell output exceeded {self.max_bytes} UTF-8 bytes"
            ) from error
        except (TypeError, ValueError) as error:
            raise SupervisorError("INVALID_KERNEL_OUTPUT", str(error)) from error
        delta = item_bytes + (1 if self.mutations else 0)
        if self.bytes_used + delta > self.max_bytes:
            raise OutputLimitError(f"cell output exceeded {self.max_bytes} UTF-8 bytes")
        self.bytes_used += delta
        self.mutations.append(mutation)


class Utf8Budget:
    """Shared fallback-interpreter output budget."""

    def __init__(self, max_bytes: int) -> None:
        self.max_bytes = max_bytes
        self.bytes_used = 0

    def consume(self, text: str) -> None:
        try:
            self.bytes_used += utf8_size(text, self.max_bytes - self.bytes_used)
        except WireLimitError as error:
            raise OutputLimitError(
                f"cell output exceeded {self.max_bytes} UTF-8 bytes"
            ) from error


class CappedTextBuffer(io.StringIO):
    """StringIO that stops user code at a configured UTF-8 byte ceiling."""

    def __init__(self, budget: Utf8Budget) -> None:
        super().__init__()
        self.budget = budget
        self.exceeded = False

    def write(self, text: str) -> int:
        if self.exceeded:
            return len(text)
        try:
            self.budget.consume(text)
        except OutputLimitError:
            self.exceeded = True
            raise
        return super().write(text)


class NotebookInterpreter(code.InteractiveInterpreter):
    """InteractiveInterpreter that records caught user-code failures."""

    def __init__(self) -> None:
        super().__init__()
        self.had_error = False

    def showsyntaxerror(self, filename: str | None = None) -> None:
        self.had_error = True
        super().showsyntaxerror(filename)

    def showtraceback(self) -> None:
        self.had_error = True
        super().showtraceback()

    def runcode(self, code_object: CodeType) -> None:
        try:
            exec(code_object, self.locals)
        except BaseException:
            self.showtraceback()


KERNEL: Any = None
KERNEL_CLIENT: Any = None
INTERPRETER: NotebookInterpreter | None = None
INTERPRETER_EXECUTION_COUNT = 0
KERNELSPEC = "python3"
BACKEND = ""
MAX_CELL_OUTPUT_BYTES = 64 * 1024 * 1024
MAX_INSPECT_BYTES = 4 * 1024 * 1024
MAX_RESPONSE_BYTES = 64 * 1024 * 1024


def encode_response(response: dict[str, Any], max_bytes: int) -> bytes:
    json_size(response, max_bytes - 1)
    rendered = json.dumps(
        response,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )
    encoded = (rendered + "\n").encode("utf-8")
    if len(encoded) > max_bytes:
        raise WireLimitError
    return encoded


def write_response(response: dict[str, Any], max_bytes: int) -> None:
    try:
        encoded = encode_response(response, max_bytes)
    except WireLimitError:
        encoded = encode_response({
            "id": response.get("id"),
            "error": {
                "code": "RESPONSE_LIMIT",
                "message": f"supervisor response exceeded {max_bytes} UTF-8 bytes",
            },
        }, max_bytes)
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def require_string(params: dict[str, Any], name: str, default: str | None = None) -> str:
    value = params.get(name, default)
    if not isinstance(value, str):
        raise SupervisorError("INVALID_PARAMS", f"{name} must be a string")
    return value


def timeout_seconds(params: dict[str, Any]) -> float:
    value = params.get("timeout_ms")
    if not isinstance(value, (int, float)) or isinstance(value, bool) or value <= 0:
        raise SupervisorError("INVALID_PARAMS", "timeout_ms must be a positive number")
    return value / 1000


def positive_byte_limit(params: dict[str, Any], hard_max: int) -> int:
    value = params.get("max_output_bytes")
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or value <= 0
        or value > hard_max
    ):
        raise SupervisorError(
            "INVALID_PARAMS",
            f"max_output_bytes must be a positive integer no greater than {hard_max}",
        )
    return value


def response_byte_limit(params: dict[str, Any]) -> int:
    value = params.get("max_response_bytes", MAX_RESPONSE_BYTES)
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or value < 256
        or value > MAX_RESPONSE_BYTES
    ):
        raise SupervisorError(
            "INVALID_PARAMS",
            f"max_response_bytes must be an integer from 256 through {MAX_RESPONSE_BYTES}",
        )
    return value


def dependency_is_unavailable(error: ModuleNotFoundError) -> bool:
    missing = error.name or ""
    return (
        missing == "jupyter_client"
        or missing.startswith("jupyter_client.")
        or missing == "ipykernel"
        or missing.startswith("ipykernel.")
    )


def start_interpreter() -> dict[str, Any]:
    global KERNEL, KERNEL_CLIENT, INTERPRETER, INTERPRETER_EXECUTION_COUNT, BACKEND
    KERNEL = None
    KERNEL_CLIENT = None
    INTERPRETER = NotebookInterpreter()
    INTERPRETER_EXECUTION_COUNT = 0
    BACKEND = "interactive_interpreter"
    return {"status": "ok", "backend": BACKEND}


def handle_start_kernel(params: dict[str, Any]) -> dict[str, Any]:
    global KERNEL, KERNEL_CLIENT, INTERPRETER, KERNELSPEC, BACKEND
    if KERNEL is not None or INTERPRETER is not None:
        raise SupervisorError("KERNEL_ALREADY_STARTED", "kernel is already started")

    requested = params.get("backend")
    if requested == "interactive_interpreter":
        return start_interpreter()
    if requested not in (None, "jupyter_client"):
        raise SupervisorError("INVALID_PARAMS", f"unknown backend {requested!r}")

    kernelspec = require_string(params, "kernelspec", "python3")
    ready_timeout = timeout_seconds(params)
    try:
        from jupyter_client import KernelManager  # type: ignore
        from jupyter_client.kernelspec import KernelSpecManager  # type: ignore
        from ipykernel.kernelspec import RESOURCES  # type: ignore
    except ModuleNotFoundError as error:
        if dependency_is_unavailable(error):
            if params.get("allow_interpreter_fallback") is True:
                return start_interpreter()
            raise SupervisorError(
                "JUPYTER_DEPENDENCY_UNAVAILABLE",
                "jupyter_client is unavailable and interpreter fallback is disabled",
            ) from error
        raise SupervisorError(
            "JUPYTER_IMPORT_FAILED",
            f"jupyter_client dependency import failed: {error}",
        ) from error
    except ImportError as error:
        raise SupervisorError(
            "JUPYTER_IMPORT_FAILED",
            f"jupyter_client dependency import failed: {error}",
        ) from error

    if kernelspec != "python3":
        raise SupervisorError(
            "KERNELSPEC_UNTRUSTED",
            "only the selected environment's native python3 kernelspec is permitted",
        )
    spec_manager = KernelSpecManager(kernel_dirs=[])
    try:
        resolved_spec = spec_manager.get_kernel_spec(kernelspec)
    except Exception as error:
        if error.__class__.__name__ == "NoSuchKernel":
            raise SupervisorError(
                "KERNELSPEC_MISSING",
                f"kernelspec {kernelspec!r} is unavailable",
            ) from error
        raise SupervisorError(
            "KERNELSPEC_UNTRUSTED",
            "the selected environment's native kernelspec could not be verified",
        ) from error
    if os.path.realpath(resolved_spec.resource_dir) != os.path.realpath(RESOURCES):
        raise SupervisorError(
            "KERNELSPEC_UNTRUSTED",
            "the python3 kernelspec does not belong to the selected environment",
        )

    manager = None
    client = None
    try:
        manager = KernelManager(kernel_name=kernelspec, kernel_spec_manager=spec_manager)
        # The kernel does not consume process stdin: Jupyter input travels on
        # its ZMQ stdin channel. Use NUL on Windows so a restricted launch does
        # not allocate an unnecessary inherited pipe or writable handle.
        start_options = {"stdin": subprocess.DEVNULL} if sys.platform == "win32" else {}
        manager.start_kernel(**start_options)
        client = manager.client()
        client.start_channels()
        client.wait_for_ready(timeout=ready_timeout)
    except Exception as error:
        if client is not None:
            try:
                client.stop_channels()
            except Exception:
                pass
        if manager is not None:
            try:
                manager.shutdown_kernel(now=True)
            except Exception:
                pass
        if error.__class__.__name__ == "NoSuchKernel":
            raise SupervisorError(
                "KERNELSPEC_MISSING",
                f"kernelspec {kernelspec!r} is unavailable",
            ) from error
        raise SupervisorError(
            "KERNEL_START_FAILED",
            f"failed to start kernelspec {kernelspec!r}: {error}",
        ) from error

    KERNEL = manager
    KERNEL_CLIENT = client
    INTERPRETER = None
    KERNELSPEC = kernelspec
    BACKEND = "jupyter_client"
    return {"status": "ok", "backend": BACKEND}


def terminal_error(
    code_value: str,
    message: str,
    mutations: list[dict[str, Any]],
    execution_count: int,
) -> dict[str, Any]:
    return {
        "status": "error",
        "mutations": mutations,
        "executionCount": execution_count,
        "error": {"code": code_value, "message": message},
    }


def stream_mutation(name: str, text: str) -> dict[str, Any]:
    return {
        "operation": "append",
        "output": {"type": "stream", "name": name, "text": text},
    }


def error_mutation(name: str, value: str, traceback_lines: list[str]) -> dict[str, Any]:
    return {
        "operation": "append",
        "output": {
            "type": "error",
            "name": name,
            "value": value,
            "traceback": traceback_lines,
        },
    }


def run_interpreter(
    source: str,
    ledger: MutationLedger,
    execution_count: int,
) -> dict[str, Any]:
    assert INTERPRETER is not None
    budget = Utf8Budget(ledger.max_bytes)
    stdout = CappedTextBuffer(budget)
    stderr = CappedTextBuffer(budget)
    old_stdout = sys.stdout
    old_stderr = sys.stderr
    sys.stdout = stdout
    sys.stderr = stderr
    INTERPRETER.had_error = False
    try:
        more = INTERPRETER.runsource(source, "<cell>", "exec")
    finally:
        sys.stdout = old_stdout
        sys.stderr = old_stderr

    stdout_text = stdout.getvalue()
    stderr_text = stderr.getvalue()
    if stdout_text:
        ledger.add(stream_mutation("stdout", stdout_text))
    if stdout.exceeded or stderr.exceeded:
        return terminal_error(
            "OUTPUT_LIMIT",
            f"cell output exceeded {ledger.max_bytes} UTF-8 bytes",
            ledger.mutations,
            execution_count,
        )
    if more:
        message = "incomplete Python input"
        return terminal_error(
            "INCOMPLETE_INPUT",
            message,
            ledger.mutations,
            execution_count,
        )
    if INTERPRETER.had_error:
        lines = [line for line in stderr_text.splitlines() if line.strip()]
        message = lines[-1] if lines else "Python execution failed"
        name, separator, value = message.partition(":")
        ledger.add(error_mutation(
            name if separator else "ExecutionError",
            value.strip() if separator else message,
            lines,
        ))
        return terminal_error(
            "EXECUTION_ERROR",
            message,
            ledger.mutations,
            execution_count,
        )
    if stderr_text:
        ledger.add(stream_mutation("stderr", stderr_text))
    return {
        "status": "ok",
        "mutations": ledger.mutations,
        "executionCount": execution_count,
    }


BINARY_MIME_TYPES = {
    "application/pdf",
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
}
MAX_SAFE_INTEGER = (1 << 53) - 1


def normalize_json_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, int):
        if abs(value) > MAX_SAFE_INTEGER:
            raise SupervisorError("INVALID_KERNEL_OUTPUT", "JSON integer exceeds JavaScript safe range")
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise SupervisorError("INVALID_KERNEL_OUTPUT", "JSON number must be finite")
        return value
    if isinstance(value, (list, tuple)):
        return [normalize_json_value(item) for item in value]
    if isinstance(value, dict):
        normalized: dict[str, Any] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise SupervisorError("INVALID_KERNEL_OUTPUT", "JSON object keys must be strings")
            normalized[key] = normalize_json_value(item)
        return normalized
    raise SupervisorError(
        "INVALID_KERNEL_OUTPUT",
        f"unsupported JSON value {type(value).__name__}",
    )


def canonical_base64(value: Any, mime_type: str) -> str:
    if not isinstance(value, str):
        raise SupervisorError("INVALID_KERNEL_OUTPUT", f"{mime_type} payload must be base64 text")
    try:
        decoded = base64.b64decode(value, validate=True)
    except (ValueError, base64.binascii.Error) as error:
        raise SupervisorError("INVALID_KERNEL_OUTPUT", f"{mime_type} payload is not base64") from error
    if base64.b64encode(decoded).decode("ascii") != value:
        raise SupervisorError("INVALID_KERNEL_OUTPUT", f"{mime_type} payload is not canonical base64")
    return value


def normalize_mime_value(mime_type: str, value: Any) -> dict[str, Any]:
    if mime_type in BINARY_MIME_TYPES:
        return {"type": "base64", "data": canonical_base64(value, mime_type)}
    if mime_type == "application/json" or mime_type.endswith("+json"):
        return {"type": "json", "value": normalize_json_value(value)}
    if isinstance(value, str):
        return {"type": "text", "text": value}
    if isinstance(value, list) and all(isinstance(part, str) for part in value):
        return {"type": "text", "text": "".join(value)}
    return {"type": "json", "value": normalize_json_value(value)}


def normalize_mime_bundle(data: Any) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise SupervisorError("INVALID_KERNEL_OUTPUT", "Jupyter MIME data must be an object")
    bundle: dict[str, Any] = {}
    for mime_type, value in data.items():
        if not isinstance(mime_type, str) or not mime_type:
            raise SupervisorError("INVALID_KERNEL_OUTPUT", "Jupyter MIME type must be non-empty text")
        bundle[mime_type] = normalize_mime_value(mime_type, value)
    return bundle


def normalize_metadata(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    normalized = normalize_json_value(value)
    if not isinstance(normalized, dict):
        raise SupervisorError("INVALID_KERNEL_OUTPUT", "Jupyter output metadata must be an object")
    return normalized


def display_id(content: Any) -> str | None:
    if not isinstance(content, dict):
        return None
    transient = content.get("transient")
    if not isinstance(transient, dict):
        return None
    value = transient.get("display_id")
    return value if isinstance(value, str) and value else None


def remaining(deadline: float) -> float:
    value = deadline - time.monotonic()
    if value <= 0:
        raise TimeoutError("kernel request timed out")
    return value


def matching_message(get_message: Any, msg_id: str, deadline: float) -> dict[str, Any]:
    while True:
        try:
            message = get_message(timeout=remaining(deadline))
        except queue.Empty as error:
            raise TimeoutError("kernel request timed out") from error
        if message.get("parent_header", {}).get("msg_id") == msg_id:
            return message


def execution_count(value: Any, subject: str) -> int:
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or value < 0
        or value > MAX_SAFE_INTEGER
    ):
        raise SupervisorError("INVALID_KERNEL_REPLY", f"{subject} requires a non-negative safe integer")
    return value


def reply_execution_count(reply: Any) -> int:
    if not isinstance(reply, dict) or not isinstance(reply.get("content"), dict):
        raise SupervisorError("INVALID_KERNEL_REPLY", "execute_reply content must be an object")
    return execution_count(reply["content"].get("execution_count"), "execute_reply execution_count")


def interrupt_and_collect_reply(msg_id: str, interrupt_timeout: float) -> dict[str, Any]:
    if KERNEL is None or KERNEL_CLIENT is None:
        raise RuntimeError("kernel is unavailable during interrupt")
    KERNEL.interrupt_kernel()
    deadline = time.monotonic() + interrupt_timeout
    while True:
        message = matching_message(KERNEL_CLIENT.get_iopub_msg, msg_id, deadline)
        if (
            message.get("msg_type") == "status"
            and message.get("content", {}).get("execution_state") == "idle"
        ):
            return matching_message(KERNEL_CLIENT.get_shell_msg, msg_id, deadline)


def interrupted_terminal(
    msg_id: str,
    interrupt_timeout: float,
    code_value: str,
    message: str,
    ledger: MutationLedger,
) -> dict[str, Any]:
    try:
        reply = interrupt_and_collect_reply(msg_id, interrupt_timeout)
        count = reply_execution_count(reply)
    except Exception as error:
        raise SupervisorError(
            "KERNEL_UNRESPONSIVE",
            f"{message}; interrupt did not reach idle with execute_reply: {error}",
        ) from error
    return terminal_error(code_value, message, ledger.mutations, count)


def handle_execute(params: dict[str, Any]) -> dict[str, Any]:
    global INTERPRETER_EXECUTION_COUNT
    source = require_string(params, "source", "")
    operation_timeout = timeout_seconds(params)
    interrupt_timeout_value = params.get("interrupt_timeout_ms")
    if (
        not isinstance(interrupt_timeout_value, (int, float))
        or isinstance(interrupt_timeout_value, bool)
        or interrupt_timeout_value <= 0
    ):
        raise SupervisorError("INVALID_PARAMS", "interrupt_timeout_ms must be a positive number")
    interrupt_timeout = interrupt_timeout_value / 1000
    max_output_bytes = positive_byte_limit(params, MAX_CELL_OUTPUT_BYTES)
    ledger = MutationLedger(max_output_bytes)
    if INTERPRETER is not None:
        INTERPRETER_EXECUTION_COUNT += 1
        try:
            return run_interpreter(source, ledger, INTERPRETER_EXECUTION_COUNT)
        except OutputLimitError as error:
            return terminal_error(
                "OUTPUT_LIMIT",
                str(error),
                ledger.mutations,
                INTERPRETER_EXECUTION_COUNT,
            )
    if KERNEL_CLIENT is None:
        raise SupervisorError("KERNEL_NOT_STARTED", "kernel is not started")

    deadline = time.monotonic() + operation_timeout
    msg_id = KERNEL_CLIENT.execute(source, stop_on_error=True)
    execution_error: dict[str, str] | None = None
    try:
        while True:
            message = matching_message(KERNEL_CLIENT.get_iopub_msg, msg_id, deadline)
            msg_type = message.get("msg_type")
            content = message.get("content", {})
            if not isinstance(content, dict):
                raise SupervisorError("INVALID_KERNEL_OUTPUT", "Jupyter message content must be an object")
            if msg_type == "clear_output":
                wait = content.get("wait", False)
                if not isinstance(wait, bool):
                    raise SupervisorError("INVALID_KERNEL_OUTPUT", "clear_output wait must be boolean")
                ledger.add({"operation": "clear", "wait": wait})
                continue
            if msg_type == "stream":
                text = content.get("text", "")
                name = content.get("name")
                if not isinstance(text, str) or name not in ("stdout", "stderr"):
                    raise SupervisorError("INVALID_KERNEL_OUTPUT", "stream output requires stdout/stderr text")
                ledger.add(stream_mutation(name, text))
            elif msg_type in ("execute_result", "display_data", "update_display_data"):
                bundle = normalize_mime_bundle(content.get("data"))
                metadata = normalize_metadata(content.get("metadata", {}))
                selected_display_id = display_id(content)
                if msg_type == "update_display_data":
                    if selected_display_id is None:
                        raise SupervisorError(
                            "INVALID_KERNEL_OUTPUT",
                            "update_display_data requires transient.display_id",
                        )
                    ledger.add({
                        "operation": "update-display",
                        "displayId": selected_display_id,
                        "data": bundle,
                        "metadata": metadata,
                    })
                else:
                    output: dict[str, Any] = {
                        "type": "execute-result" if msg_type == "execute_result" else "display",
                        "data": bundle,
                        "metadata": metadata,
                    }
                    if msg_type == "execute_result":
                        raw_count = content.get("execution_count")
                        output["executionCount"] = (
                            None
                            if raw_count is None
                            else execution_count(raw_count, "execute_result execution_count")
                        )
                    if selected_display_id is not None:
                        output["displayId"] = selected_display_id
                    ledger.add({"operation": "append", "output": output})
            elif msg_type == "error":
                traceback_lines = content.get("traceback", [])
                ename = content.get("ename")
                evalue = content.get("evalue")
                if (
                    not isinstance(ename, str)
                    or not isinstance(evalue, str)
                    or not isinstance(traceback_lines, list)
                    or not all(isinstance(line, str) for line in traceback_lines)
                ):
                    raise SupervisorError("INVALID_KERNEL_OUTPUT", "invalid Jupyter error output")
                ledger.add(error_mutation(ename, evalue, traceback_lines))
                execution_error = {
                    "code": "EXECUTION_ERROR",
                    "message": f"{ename}: {evalue}" if ename else (evalue or "kernel execution failed"),
                }
            elif msg_type == "status" and content.get("execution_state") == "idle":
                break
        reply = matching_message(KERNEL_CLIENT.get_shell_msg, msg_id, deadline)
    except OutputLimitError as error:
        return interrupted_terminal(
            msg_id,
            interrupt_timeout,
            "OUTPUT_LIMIT",
            str(error),
            ledger,
        )
    except TimeoutError as error:
        return interrupted_terminal(
            msg_id,
            interrupt_timeout,
            "EXECUTION_TIMEOUT",
            str(error),
            ledger,
        )

    reply_content = reply.get("content", {})
    if not isinstance(reply_content, dict):
        raise SupervisorError("INVALID_KERNEL_REPLY", "execute_reply content must be an object")
    count = reply_execution_count(reply)
    reply_status = reply_content.get("status")
    if execution_error is None and reply_status != "ok":
        ename = reply_content.get("ename")
        evalue = reply_content.get("evalue")
        traceback_lines = reply_content.get("traceback", [])
        normalized_name = ename if isinstance(ename, str) else "ExecutionError"
        normalized_value = evalue if isinstance(evalue, str) else f"kernel returned {reply_status!r}"
        normalized_traceback = (
            traceback_lines
            if isinstance(traceback_lines, list) and all(isinstance(line, str) for line in traceback_lines)
            else []
        )
        try:
            ledger.add(error_mutation(normalized_name, normalized_value, normalized_traceback))
        except OutputLimitError as error:
            return terminal_error(
                "OUTPUT_LIMIT",
                str(error),
                ledger.mutations,
                count,
            )
        execution_error = {
            "code": "EXECUTION_ERROR",
            "message": f"{normalized_name}: {normalized_value}",
        }
    if execution_error is not None:
        return terminal_error(
            execution_error["code"],
            execution_error["message"],
            ledger.mutations,
            count,
        )
    return {"status": "ok", "mutations": ledger.mutations, "executionCount": count}


def handle_inspect(params: dict[str, Any]) -> dict[str, Any]:
    name = require_string(params, "name", "")
    operation_timeout = timeout_seconds(params)
    max_output_bytes = positive_byte_limit(params, MAX_INSPECT_BYTES)
    if INTERPRETER is not None:
        if name not in INTERPRETER.locals:
            return {"status": "ok", "found": False, "text": ""}
        value = INTERPRETER.locals[name]
        text = f"{name} = {value!r}"
        try:
            utf8_size(text, max_output_bytes)
        except WireLimitError:
            raise SupervisorError(
                "INSPECT_OUTPUT_LIMIT",
                f"inspect output exceeded {max_output_bytes} UTF-8 bytes",
            )
        return {"status": "ok", "found": True, "text": text}
    if KERNEL_CLIENT is None:
        raise SupervisorError("KERNEL_NOT_STARTED", "kernel is not started")

    msg_id = KERNEL_CLIENT.inspect(name, len(name), detail_level=0)
    try:
        reply = matching_message(
            KERNEL_CLIENT.get_shell_msg,
            msg_id,
            time.monotonic() + operation_timeout,
        )
    except TimeoutError as error:
        raise SupervisorError("INSPECT_TIMEOUT", str(error)) from error
    content = reply.get("content", {})
    if content.get("status") != "ok":
        raise SupervisorError("INSPECT_FAILED", str(content.get("evalue") or "kernel inspection failed"))
    if content.get("found") is not True:
        return {"status": "ok", "found": False, "text": ""}
    data = content.get("data", {})
    text = data.get("text/plain", "") if isinstance(data, dict) else ""
    if isinstance(text, list):
        text = "".join(part for part in text if isinstance(part, str))
    normalized = text if isinstance(text, str) else ""
    try:
        utf8_size(normalized, max_output_bytes)
    except WireLimitError:
        raise SupervisorError(
            "INSPECT_OUTPUT_LIMIT",
            f"inspect output exceeded {max_output_bytes} UTF-8 bytes",
        )
    return {"status": "ok", "found": True, "text": normalized}


def stop_kernel(suppress_errors: bool) -> None:
    global KERNEL, KERNEL_CLIENT, INTERPRETER, INTERPRETER_EXECUTION_COUNT, BACKEND
    errors: list[Exception] = []
    client = KERNEL_CLIENT
    manager = KERNEL
    KERNEL_CLIENT = None
    KERNEL = None
    INTERPRETER = None
    INTERPRETER_EXECUTION_COUNT = 0
    BACKEND = ""
    if client is not None:
        try:
            client.stop_channels()
        except Exception as error:
            errors.append(error)
    if manager is not None:
        try:
            manager.shutdown_kernel(now=True)
        except Exception as error:
            errors.append(error)
    if errors and not suppress_errors:
        raise SupervisorError("KERNEL_SHUTDOWN_FAILED", "; ".join(str(error) for error in errors))


def handle_restart(params: dict[str, Any]) -> dict[str, Any]:
    kernelspec = require_string(params, "kernelspec", KERNELSPEC)
    backend = params.get("backend", BACKEND or None)
    operation_timeout = params.get("timeout_ms")
    stop_kernel(False)
    return handle_start_kernel({
        "kernelspec": kernelspec,
        "backend": backend,
        "timeout_ms": operation_timeout,
    })


def handle_shutdown(_params: dict[str, Any]) -> dict[str, Any]:
    stop_kernel(False)
    return {"status": "ok"}


METHODS = {
    "start_kernel": handle_start_kernel,
    "execute": handle_execute,
    "inspect": handle_inspect,
    "restart": handle_restart,
    "shutdown": handle_shutdown,
}


def error_response(request_id: Any, error: Exception) -> dict[str, Any]:
    if isinstance(error, SupervisorError):
        details = error.details
        payload = {"code": error.code, "message": str(error)}
        if details is not None:
            payload["details"] = details
        return {"id": request_id, "error": payload}
    return {
        "id": request_id,
        "error": {"code": "SUPERVISOR_INTERNAL_ERROR", "message": str(error)},
    }


def parse_request(line: str) -> tuple[int, str, dict[str, Any]]:
    request = json.loads(line)
    if not isinstance(request, dict):
        raise SupervisorError("INVALID_REQUEST", "request must be an object")
    request_id = request.get("id")
    if not isinstance(request_id, int) or isinstance(request_id, bool):
        raise SupervisorError("INVALID_REQUEST", "request id must be an integer")
    method = request.get("method")
    if not isinstance(method, str):
        raise SupervisorError("INVALID_REQUEST", "request method must be a string")
    params = request.get("params", {})
    if not isinstance(params, dict):
        raise SupervisorError("INVALID_REQUEST", "request params must be an object")
    return request_id, method, params


def main() -> None:
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            request_id: Any = None
            max_response_bytes = MAX_RESPONSE_BYTES
            try:
                request_id, method, params = parse_request(line)
                max_response_bytes = response_byte_limit(params)
                handler = METHODS.get(method)
                if handler is None:
                    raise SupervisorError("METHOD_NOT_FOUND", f"unknown method {method}")
                result = handler(params)
                write_response({"id": request_id, "result": result}, max_response_bytes)
                if method == "shutdown":
                    return
            except Exception as error:
                write_response(error_response(request_id, error), max_response_bytes)
    finally:
        stop_kernel(True)


if __name__ == "__main__":
    main()
