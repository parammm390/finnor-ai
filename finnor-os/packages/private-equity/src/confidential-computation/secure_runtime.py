"""MP-SPDZ arithmetic tape builder. Executed only by its pinned compiler.

Every private value, nonce, branch and validation flag stays secret until an
explicit abort predicate or recipient-private open. No local plaintext oracle.
"""
import json
from functools import lru_cache
from pathlib import Path

from Compiler.library import check_point, print_ln, print_ln_to, runtime_error_if
from Compiler.types import sint
from backend import output_layout, output_prefix

WIDTH = 84


def xor(a, b):
    if isinstance(a, int):
        return b if a == 0 else 1 - b
    if isinstance(b, int):
        return a if b == 0 else 1 - a
    return a + b - 2 * a * b


def conjunction(a, b):
    if isinstance(a, int):
        return 0 if a == 0 else b
    if isinstance(b, int):
        return 0 if b == 0 else a
    return a * b


@lru_cache(maxsize=1)
def circuit_layers(circuit_path):
    lines = Path(circuit_path).read_text().splitlines()
    count, wire_count = map(int, lines[0].split())
    if lines[1].split() != ["2", "512", "256"] or lines[2].split() != ["1", "256"] \
            or wire_count != 135841 or count != 135073:
        raise ValueError("PINNED_HASH_CIRCUIT_SHAPE_MISMATCH")
    levels, layers, gates = [0] * 768 + [None] * (wire_count - 768), [], 0
    for line in lines[3:]:
        if not line.strip():
            continue
        row = line.split()
        if row[:2] == ["2", "1"] and row[-1] in ("AND", "XOR"):
            inputs, destination = list(map(int, row[2:4])), int(row[4])
        elif row[:2] == ["1", "1"] and row[-1] == "INV":
            inputs, destination = [int(row[2])], int(row[3])
        else:
            raise ValueError("PINNED_HASH_CIRCUIT_GATE_UNSUPPORTED")
        if not 0 <= destination < wire_count or levels[destination] is not None \
                or any(not 0 <= i < wire_count or levels[i] is None for i in inputs):
            raise ValueError("PINNED_HASH_CIRCUIT_TOPOLOGY_INVALID")
        level = max(levels[i] for i in inputs) + 1
        levels[destination] = level
        while len(layers) <= level:
            layers.append([])
        layers[level].append((row[-1], inputs, destination))
        gates += 1
    if gates != count:
        raise ValueError("PINNED_HASH_CIRCUIT_TRUNCATED")
    return layers, wire_count


def evaluate_layer(wires, layer):
    """Batch only topologically independent gates; folding uses PUBLIC bits."""
    batches = {"AND": [], "XOR": [], "INV": []}
    for operation, inputs, destination in layer:
        a = wires[inputs[0]]
        if operation == "INV":
            if isinstance(a, int):
                wires[destination] = 1 - a
            else:
                batches["INV"].append((a, None, destination))
            continue
        b = wires[inputs[1]]
        if isinstance(a, int) or isinstance(b, int):
            public, secret = (a, b) if isinstance(a, int) else (b, a)
            if operation == "AND":
                wires[destination] = 0 if public == 0 else secret
            elif public == 0:
                wires[destination] = secret
            elif isinstance(secret, int):
                wires[destination] = 1 - secret
            else:
                batches["INV"].append((secret, None, destination))
        else:
            batches[operation].append((a, b, destination))
    for operation in ("AND", "XOR", "INV"):
        batch = batches[operation]
        if not batch:
            continue
        left = sint.concat(item[0] for item in batch)
        if operation == "INV":
            result = 1 - left
        else:
            right = sint.concat(item[1] for item in batch)
            result = left * right if operation == "AND" else left + right - 2 * left * right
        for index, (_, _, destination) in enumerate(batch):
            wires[destination] = result[index]


def sha256_bits(message_bits, circuit_path):
    """Pinned Bristol compression with standard, fixed public-length padding.

    Circuit inputs: reversed 512 message bits then reversed 256 chaining bits.
    Padding is PUBLIC and the secret message length is fixed by the profile.
    """
    initial = bytes.fromhex("6a09e667bb67ae853c6ef372a54ff53a"
                            "510e527f9b05688c1f83d9ab5be0cd19")
    public_bits = lambda b: [(v >> shift) & 1 for v in b for shift in range(7, -1, -1)]
    if len(message_bits) % 8:
        raise ValueError("BYTE_ALIGNED_HASH_MESSAGE_REQUIRED")
    layers, wire_count = circuit_layers(str(circuit_path))
    padded = list(message_bits) + [1] + [0] * ((447 - len(message_bits)) % 512)
    padded += public_bits(len(message_bits).to_bytes(8, "big"))
    state = public_bits(initial)
    for offset in range(0, len(padded), 512):
        wires = padded[offset:offset + 512][::-1] + state[::-1]
        wires += [None] * (wire_count - len(wires))
        for layer in layers:
            evaluate_layer(wires, layer)
        state = wires[-256:][::-1]
    return state


def sha256_40_bytes(message_bits, circuit_path):
    if len(message_bits) != 320:
        raise ValueError("EXACT_INPUT_COMMITMENT_LENGTH_REQUIRED")
    return sha256_bits(message_bits, circuit_path)


def less(a, b):
    return sint.conv(a).less_than(b, bit_length=WIDTH)


def equal(a, b):
    return sint.conv(a).equal(b, bit_length=WIDTH)


def select(bit, yes, no):
    return no + bit * (yes - no)


def exact_signed_division(numerator, denominator):
    """Oblivious, fixed-width binary long division with exact remainder."""
    nneg, dneg = less(numerator, 0), less(denominator, 0)
    nabs, dabs = select(nneg, -numerator, numerator), select(dneg, -denominator, denominator)
    nonzero = 1 - equal(dabs, 0)
    safe_denominator = select(nonzero, dabs, 1)
    bits = nabs.bit_decompose(WIDTH)
    remainder, quotient = sint(0), sint(0)
    for bit in reversed(bits):
        remainder = remainder * 2 + bit
        take = 1 - less(remainder, safe_denominator)
        remainder -= take * safe_denominator
        quotient = quotient * 2 + take
    quotient = select(xor(nneg, dneg), -quotient, quotient)
    return quotient, conjunction(nonzero, equal(remainder, 0))


def execute(protocol, binding, circuit_path):
    function = protocol["function"]
    participants = [p["id"] for p in function["participants"]]
    values, valid = [], []
    bindings = {b["key"]: b for b in binding["inputs"]}
    input_values = []
    for port in function["inputs"]:
        player = participants.index(port["participantId"])
        # Input owner supplies 64 little-endian two's-complement bits, followed
        # by 128 MSB-first random-nonce bits, on that participant's machine only.
        bits = [sint.get_input_from(player) for _ in range(192)]
        opened_checks = [(b * (b - 1)).reveal() for b in bits]
        check_point()
        for check in opened_checks:
            runtime_error_if(check != 0, "Y4_INPUT_BIT_DOMAIN_REJECTED")
        value = sum(b * (2 ** i) for i, b in enumerate(bits[:64])) - bits[63] * (2 ** 64)
        b = bindings[port["key"]]
        prefix = bytes.fromhex(b["bindingPrefix"])
        message = [(byte >> shift) & 1 for byte in prefix for shift in range(7, -1, -1)]
        message += bits[64:] + bits[:64][::-1]
        hashed = sha256_40_bytes(message, circuit_path)
        expected = [(byte >> shift) & 1 for byte in bytes.fromhex(b["commitment"])
                    for shift in range(7, -1, -1)]
        # Compare 4 disjoint 64-bit words, never a sum that can cancel.
        checks = [(sum((x - y) * 2 ** (63 - j) for j, (x, y) in
                       enumerate(zip(hashed[i:i + 64], expected[i:i + 64])))).reveal()
                  for i in range(0, 256, 64)]
        check_point()
        for check in checks:
            runtime_error_if(check != 0, "Y4_INPUT_COMMITMENT_REJECTED")
        input_values.append(value)
    for node in protocol["nodes"]:
        operation = node["op"]
        if operation == "input":
            value = input_values[node["inputIndex"]]
            okay = conjunction(1 - less(value, int(node["low"])),
                               1 - less(int(node["high"]), value))
        elif operation == "literal":
            value, okay = sint(int(node["value"])), sint(1)
        else:
            a, b = values[node["left"]], values[node["right"]]
            okay = conjunction(valid[node["left"]], valid[node["right"]])
            if operation in ("add", "subtract", "min", "max", "if"):
                a, b = a * int(node["leftFactor"]), b * int(node["rightFactor"])
            if operation == "add":
                value = a + b
            elif operation == "subtract":
                value = a - b
            elif operation == "multiply":
                value = a * b
            elif operation in ("min", "max"):
                take = less(a, b)
                value = select(take, a, b) if operation == "min" else select(take, b, a)
            elif operation == "ratio":
                value, division_ok = exact_signed_division(
                    a * int(node["numeratorFactor"]), b * int(node["denominatorFactor"]))
                okay = conjunction(okay, division_ok)
            elif operation == "if":
                comparison = node["comparison"]
                if comparison == "lt":
                    choice = less(a, b)
                elif comparison == "lte":
                    choice = 1 - less(b, a)
                elif comparison == "eq":
                    choice = equal(a, b)
                elif comparison == "gte":
                    choice = 1 - less(a, b)
                else:
                    choice = less(b, a)
                y, n = node["whenTrue"], node["whenFalse"]
                value = select(choice, values[y] * int(node["trueFactor"]),
                               values[n] * int(node["falseFactor"]))
                okay = conjunction(okay, select(choice, valid[y], valid[n]))
            else:
                raise ValueError("CHECKED_OPERATION_UNIMPLEMENTED")
        # Invalid inputs/intermediates become a benign in-range zero. Selected
        # invalid branches still carry false validity, never field-wrap numbers.
        okay = conjunction(okay, conjunction(1 - less(value, int(node["low"])),
                                             1 - less(int(node["high"]), value)))
        values.append(select(okay, value, 0))
        valid.append(okay)
    accepted = sint(1)
    for output in protocol["outputs"]:
        accepted = conjunction(accepted, valid[output["register"]])
    accepted = accepted.reveal()
    check_point()
    runtime_error_if(accepted != 1, "Y4_EXACT_NUMERICAL_PREMISE_REJECTED")
    # The commitment is produced and MAC-checked INSIDE MPC. Every participant
    # observes it, while only its recipient knows the random opening nonce.
    commitments = []
    by_key = {o["key"]: o for o in protocol["outputs"]}
    for player, participant in enumerate(participants):
        layout = output_layout(protocol, participant)
        if not layout:
            continue
        nonce = [sint.get_input_from(player) for _ in range(128)]
        nonce_checks = [(bit * (bit - 1)).reveal() for bit in nonce]
        check_point()
        for bit_check in nonce_checks:
            runtime_error_if(bit_check != 0, "Y4_OUTPUT_NONCE_BIT_DOMAIN_REJECTED")
        prefix = bytes.fromhex(output_prefix(protocol, binding, participant))
        message = [(byte >> shift) & 1 for byte in prefix for shift in range(7, -1, -1)] + nonce
        for port in layout:
            value = values[by_key[port["key"]]["register"]] - int(port["low"])
            width = (int(port["high"]) - int(port["low"])).bit_length()
            bits = value.bit_decompose(max(1, width))
            message += [0] * (port["bytes"] * 8 - len(bits)) + bits[::-1]
        hashed = sha256_bits(message, circuit_path)
        words = [sum(bit * 2 ** (63 - j) for j, bit in enumerate(hashed[i:i + 64])).reveal()
                 for i in range(0, 256, 64)]
        commitments.append((player, words))
    check_point()
    for player, words in commitments:
        print_ln("Y4_OUTPUT_COMMITMENT:%s:%s:%s:%s:%s", player, *words)
    opened = []
    for index, output in enumerate(protocol["outputs"]):
        for participant in output["recipients"]:
            player = participants.index(participant)
            opened.append((player, index, values[output["register"]].reveal_to(player)))
    check_point()
    for player, index, value in opened:
        print_ln_to(player, "Y4_RESULT:%s:%s", index, value)
    check_point()
