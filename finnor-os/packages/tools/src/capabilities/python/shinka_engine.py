"""Actual pinned Shinka runner; generated code can only reach the scoped broker."""
import contextlib
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import random
import shutil
import sys
import tempfile
import urllib.parse


def run(payload):
    endpoint = urllib.parse.urlparse(payload["brokerUrl"])
    if endpoint.scheme != "http" or endpoint.hostname != "127.0.0.1" or endpoint.username or endpoint.password:
        raise ValueError("SHINKA_BROKER_ENDPOINT_INVALID")
    trusted_evaluator = Path(__file__).with_name("shinka_evaluator.py").resolve()
    evaluator_digest = hashlib.sha256(trusted_evaluator.read_bytes()).hexdigest()
    with tempfile.TemporaryDirectory(prefix="finnor-shinka-") as directory:
        # The upstream package loads cwd .env on import. A fresh private directory
        # and a package with no .env prevent ambient developer secrets being read.
        os.chdir(directory)
        distribution = importlib.metadata.distribution("shinka-evolve")
        if (Path(distribution.locate_file("shinka")) / ".env").exists():
            raise ValueError("SHINKA_PACKAGE_DOTENV_FORBIDDEN")
        os.environ.update({"SHINKA_PRICING_MODE": "offline", "SHINKA_CACHE_DIR": str(Path(directory) / "cache"), "SHINKA_LLM_TIMEOUT": "15",
            "SHINKA_LLM_MAX_RETRIES": "1", "SHINKA_OPENAI_MAX_RETRIES": "0", "SHINKA_LLM_BACKOFF_MAX_TRIES": "1", "SHINKA_LLM_BACKOFF_MAX_TIME": "15",
            "LOCAL_OPENAI_API_KEY": payload["brokerToken"], "FINNOR_SHINKA_BROKER_TOKEN": payload["brokerToken"], "FINNOR_SHINKA_BROKER": payload["brokerUrl"],
            "FINNOR_SHINKA_DEADLINE": str(payload["deadlineAt"]), "MPLCONFIGDIR": str(Path(directory) / "matplotlib")})
        import numpy as np
        from shinka.core import EvolutionConfig, ShinkaEvolveRunner
        from shinka.database import DatabaseConfig
        from shinka.launch import LocalJobConfig
        random.seed(payload["seed"])
        np.random.seed(payload["seed"])
        seed_path = Path(directory) / "initial.py"
        seed_path.write_text(payload["seedCode"])
        evaluate_path = Path(directory) / "evaluate.py"
        shutil.copyfile(trusted_evaluator, evaluate_path)
        results_dir = Path(directory) / "results"
        config = EvolutionConfig(task_sys_msg=payload["taskInstruction"], init_program_path=str(seed_path), results_dir=str(results_dir),
            num_generations=payload["generations"], llm_models=["local/finnor@" + payload["brokerUrl"] + "/v1"], llm_dynamic_selection=None,
            llm_kwargs={"temperatures": 0.1, "max_tokens": 4096, "reasoning_efforts": "disabled", "verbose": False}, patch_types=["full"], patch_type_probs=[1.0], max_patch_resamples=1, max_patch_attempts=1,
            meta_rec_interval=None, embedding_model=None, max_novelty_attempts=1, use_text_feedback=True, enable_wandb_logging=False)
        job = LocalJobConfig(eval_program_path=str(evaluate_path), python_executable=sys.executable, time="00:03:00", eval_verbose=False, numeric_threads_per_job=1)
        database = DatabaseConfig(db_path=str(results_dir / "evolution.sqlite"), num_islands=1, archive_size=16, num_archive_inspirations=0, num_top_k_inspirations=0,
            enable_dynamic_islands=False, max_stdout_log_chars=8192)
        runner = ShinkaEvolveRunner(evo_config=config, job_config=job, db_config=database, verbose=False, max_evaluation_jobs=1, max_proposal_jobs=1, max_db_workers=1)
        runner.run()
        programs = runner.db.get_all_programs()
        correct = [program for program in programs if program.correct]
        if not correct:
            raise ValueError("SHINKA_NO_CHECKED_CANDIDATE")
        best = max(correct, key=lambda program: program.combined_score)
        return {"schema": "finnor.shinka-optimizer-result.v1", "bestCode": best.code, "bestProgramId": best.id,
            "programs": [{"id": program.id, "parentId": program.parent_id, "generation": program.generation, "codeSha256": hashlib.sha256(program.code.encode()).hexdigest(),
                "score": float(program.combined_score), "correct": bool(program.correct)} for program in programs],
            "trustedEvaluatorSha256": evaluator_digest, "backend": {"name": "ShinkaEvolve", "version": importlib.metadata.version("shinka-evolve"), "commit": "8adc053a2ce4511ad2ac310e004c530a73fb974a"},
            "qualification": "CANDIDATE_SELECTION_USING_FINNOR_SANDBOX_AND_INDEPENDENT_CHECKER; HOLDOUT_AND_ADMISSION_STILL_REQUIRED"}


if __name__ == "__main__":
    try:
        request = json.loads(sys.stdin.buffer.read(16_777_217))
        with contextlib.redirect_stdout(sys.stderr):
            result = run(request)
        print(json.dumps({"ok": True, "sourceSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "result": result}, allow_nan=False, separators=(",", ":")))
    except ModuleNotFoundError:
        print(json.dumps({"ok": False, "code": "SHINKA_DEPENDENCY_UNAVAILABLE"}))
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and str(error).startswith("SHINKA_") else "SHINKA_EVOLUTION_FAILED"
        print(json.dumps({"ok": False, "code": code}))
