"""Loopback gRPC protocol fixture, NOT a VM or hostile-code isolation test.

The official Modal SDK sends real protocol messages. This service records them
and returns labelled synthetic results. It NEVER executes the submitted code.
"""
import asyncio
import base64
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import sys
import time
from google.protobuf.json_format import MessageToDict
from google.protobuf.message_factory import GetMessageClass
from grpclib.const import Cardinality, Handler, Status
from grpclib.exceptions import GRPCError
from grpclib.server import Server
from modal_proto import api_pb2, task_command_router_pb2

if os.environ.get("FINNOR_MODAL_PROTOCOL_FIXTURE") != "1":
    raise SystemExit("EXPLICIT_PROTOCOL_FIXTURE_MODE_REQUIRED")
output = Path(sys.argv[1])
output.mkdir(parents=True, exist_ok=True)
observations, sandboxes = [], {}
service = api_pb2.DESCRIPTOR.services_by_name["ModalClient"]
router_service = task_command_router_pb2.DESCRIPTOR.services_by_name["TaskCommandRouter"]
router_url = ""
def token():
    encode = lambda value: base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")
    return encode({"alg": "none"}) + "." + encode({"exp": time.time() + 3600}) + ".fixture"


def persist():
    (output / "modal-protocol-observed.json").write_text(json.dumps({"qualification": "OFFICIAL_SDK_LOOPBACK_GRPC_ONLY_NO_VM_OR_USER_CODE_EXECUTION", "requests": observations,
        "sandboxes": {key: {"terminated": value["terminated"], "inputSupplied": value["program"] is not None} for key, value in sandboxes.items()}}, indent=2) + "\n")


class Fixture:
    def __mapping__(self):
        mapping = {}
        for method in [*service.methods, *router_service.methods]:
            if method.client_streaming:
                continue
            request_type, response_type = GetMessageClass(method.input_type), GetMessageClass(method.output_type)
            mapping["/" + method.containing_service.full_name + "/" + method.name] = Handler(self.handler(method.name, response_type), Cardinality.UNARY_STREAM if method.server_streaming else Cardinality.UNARY_UNARY, request_type, response_type)
        return mapping

    def handler(self, name, response_type):
        async def handle(stream):
            request = await stream.recv_message()
            if len(observations) >= 2000:
                raise GRPCError(Status.RESOURCE_EXHAUSTED)
            observations.append({"method": name, "request": MessageToDict(request, preserving_proto_field_name=True)})
            try:
                if name == "ClientHello":
                    await stream.send_message(response_type())
                elif name == "AuthTokenGet":
                    await stream.send_message(response_type(token=token()))
                elif name == "AppGetOrCreate":
                    if request.app_name == "finnor-pre-dispatch-refusal-fixture":
                        raise GRPCError(Status.NOT_FOUND, "Synthetic application lookup refusal before Sandbox.create")
                    await stream.send_message(response_type(app_id="ap-Fixture123"))
                elif name == "ImageFromId":
                    await stream.send_message(response_type(image_id=request.image_id))
                elif name in ("SandboxCreate", "SandboxCreateV2"):
                    key = "sb-Fixture" + str(len(sandboxes) + 1)
                    task_id = "ta-Fixture" + str(len(sandboxes) + 1)
                    sandboxes[key] = {"program": None, "terminated": False, "input": bytearray(), "taskId": task_id, "definition": MessageToDict(request.definition, preserving_proto_field_name=True)}
                    await stream.send_message(response_type(sandbox_id=key, **({"task_id": task_id, "command_router_access": api_pb2.CommandRouterAccess(url=router_url, jwt=token())} if name.endswith("V2") else {})))
                elif name in ("SandboxGetTaskId", "SandboxGetTaskIdV2"):
                    await stream.send_message(response_type(task_id=sandboxes[request.sandbox_id]["taskId"]))
                elif name == "SandboxGetCommandRouterAccess":
                    await stream.send_message(response_type(url=router_url, jwt=token()))
                elif name == "SandboxSetName":
                    await stream.send_message(response_type())
                elif name in ("SandboxStdinWrite", "SandboxStdinWriteV2"):
                    state = sandboxes[request.sandbox_id] if name == "SandboxStdinWrite" else next(value for value in sandboxes.values() if value["taskId"] == request.task_id)
                    data = request.input if name == "SandboxStdinWrite" else request.data
                    offset = len(state["input"]) if name == "SandboxStdinWrite" else request.offset
                    if offset > len(state["input"]): raise GRPCError(Status.INVALID_ARGUMENT)
                    state["input"][offset:offset + len(data)] = data
                    if len(state["input"]) > 16_777_216:
                        raise GRPCError(Status.RESOURCE_EXHAUSTED)
                    if request.eof:
                        program = json.loads(state["input"])
                        if hashlib.sha256(program["code"].encode()).hexdigest() != program["codeSha256"]:
                            raise GRPCError(Status.INVALID_ARGUMENT)
                        for source in program["sources"]:
                            if hashlib.sha256(base64.b64decode(source["bytesBase64"], validate=True)).hexdigest() != source["sha256"]:
                                raise GRPCError(Status.INVALID_ARGUMENT)
                        state["program"] = program
                    await stream.send_message(response_type())
                elif name in ("SandboxWait", "SandboxWaitV2"):
                    state = sandboxes[request.sandbox_id]
                    completed = state["program"] is not None or state["terminated"]
                    await stream.send_message(response_type(result=api_pb2.GenericResult(status=api_pb2.GenericResult.GENERIC_STATUS_SUCCESS if completed else 0)))
                elif name in ("SandboxGetLogs", "SandboxStdioReadV2"):
                    state = sandboxes[request.sandbox_id] if name == "SandboxGetLogs" else next(value for value in sandboxes.values() if value["taskId"] == request.task_id)
                    program = state["program"]
                    text = ""
                    stdout_descriptor = api_pb2.FILE_DESCRIPTOR_STDOUT if name == "SandboxGetLogs" else task_command_router_pb2.SANDBOX_STDIO_FILE_DESCRIPTOR_STDOUT
                    if request.file_descriptor == stdout_descriptor and program is not None:
                        printed = "MODAL_PROTOCOL_FIXTURE_ONLY\n"
                        if program.get("stdin", "").startswith('{"problems":'):
                            problems = json.loads(program["stdin"])["problems"]
                            all_policies = "SELECT_ALL" in program["code"]
                            printed = json.dumps({"solutions": [{"taskId": task["taskId"], "selectedPolicyIds": [policy["ref"]["id"] for policy in (task["problem"]["policies"] if all_policies else task["problem"]["policies"][:1])]} for task in problems]})
                        text = json.dumps({"schema": "finnor.modal-program-result.v1", "exitCode": 0, "failure": None,
                            "stdoutBase64": base64.b64encode(printed.encode()).decode(), "stderrBase64": "", "codeSha256": program["codeSha256"],
                            "sources": [{"path": "/fixture/input/" + str(index), "sha256": source["sha256"], "source": source["source"]} for index, source in enumerate(program["sources"])], "candidateUid": 65534}, separators=(",", ":")) + "\n"
                    if name == "SandboxStdioReadV2":
                        if text.encode()[request.offset:]:
                            await stream.send_message(response_type(data=text.encode()[request.offset:], starting_offset=request.offset))
                    else:
                        items = [api_pb2.TaskLogs(data=text, file_descriptor=request.file_descriptor)] if text else []
                        await stream.send_message(response_type(items=items, eof=True, entry_id="fixture-final"))
                elif name in ("SandboxTerminate", "SandboxTerminateV2"):
                    sandboxes[request.sandbox_id]["terminated"] = True
                    await stream.send_message(response_type(existing_result=api_pb2.GenericResult(status=api_pb2.GenericResult.GENERIC_STATUS_SUCCESS)))
                else:
                    raise GRPCError(Status.UNIMPLEMENTED, name)
            finally:
                persist()
        return handle


async def main():
    global router_url
    server = Server([Fixture()])
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", int(os.environ.get("FINNOR_MODAL_FIXTURE_PORT", "0"))))
        port = reservation.getsockname()[1]
    await server.start("127.0.0.1", port)
    router_url = "http://127.0.0.1:" + str(port)
    print(json.dumps({"ready": True, "url": "http://127.0.0.1:" + str(port), "qualification": "PROTOCOL_FIXTURE_NO_VM"}), flush=True)
    stopped = asyncio.Event()
    for sig in [signal.SIGTERM, signal.SIGINT]:
        asyncio.get_running_loop().add_signal_handler(sig, stopped.set)
    await stopped.wait()
    server.close()
    await server.wait_closed()
    persist()


asyncio.run(main())
