#!/usr/bin/env python3
"""Pinned open exact runtime; serial scientific packaging, no solver license key.

Build selected executables, not unused VIPR parallel/completion targets. The
initial path disables cuts/presolve and refuses an incomplete proof. GNU library
sources, notices and relinkable shared libraries remain in the build custody.
"""
import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

PINS = {
 'gmp': ('https://ftp.gnu.org/gnu/gmp/gmp-6.3.0.tar.xz', 'a3c2b80201b89e68616f4ad30bc66aee4927c3ce50e33929ca819d5c43538898', 'gmp-6.3.0', 'xz'),
 'mpfr': ('https://www.mpfr.org/mpfr-4.2.2/mpfr-4.2.2.tar.xz', 'b67ba0383ef7e8a8563734e2e889ef5ec3c3b898a01d00fa0a6869ad81c6ce01', 'mpfr-4.2.2', 'xz'),
 'boost': ('https://archives.boost.io/release/1.85.0/source/boost_1_85_0.tar.bz2', '7009fe1faa1697476bdc7027703a2badb84e849b7b0baad5086b087b971f8617', 'boost_1_85_0', 'bz2'),
 'soplex': ('https://codeload.github.com/scipopt/soplex/tar.gz/2207cfb274dbce5c2644911dd621438535733607', 'a5719b584d1995582812ad0ec72ddfca2c0441f2ff16da69eee72d1dc65031df', 'soplex-2207cfb274dbce5c2644911dd621438535733607', 'gz'),
 'scip': ('https://codeload.github.com/scipopt/scip/tar.gz/0c80fdd8e91d7d9f23c0c7a55b68884209d5f27c', '1f149c6d30443193c0e8bae4cba9929a43d2bb35c8952d18a44bb23193d7312c', 'scip-0c80fdd8e91d7d9f23c0c7a55b68884209d5f27c', 'gz'),
 'vipr': ('https://codeload.github.com/scipopt/vipr/tar.gz/30f2951d1e90e47afa821bdd1b12b82246656c42', 'bfd905e3378353b5f4e93ad2405c75feed0d477e0a74113496fb2d6e04ca7786', 'vipr-30f2951d1e90e47afa821bdd1b12b82246656c42', 'gz')}


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def portable_darwin(runtime):
    """Relocate only owned built bytes. System dependencies remain explicit."""
    seen = set()
    for folder in ('lib', 'bin'):
        for candidate in sorted((runtime/folder).iterdir()):
            file = candidate.resolve()
            if not file.is_file() or file in seen or (folder == 'lib' and '.dylib' not in file.name):
                continue
            seen.add(file)
            linked = subprocess.check_output(['otool', '-L', str(file)], text=True)
            for line in linked.splitlines()[1:]:
                library = line.strip().split(' (')[0]
                if library.startswith(str(runtime/'lib')+'/'):
                    subprocess.run(['install_name_tool', '-change', library, '@rpath/'+Path(library).name, str(file)], check=True, capture_output=True)
            if folder == 'lib':
                subprocess.run(['install_name_tool', '-id', '@rpath/'+candidate.name, str(file)], check=True, capture_output=True)
            rpath = '@loader_path' if folder == 'lib' else '@loader_path/../lib'
            commands = subprocess.check_output(['otool', '-l', str(file)], text=True)
            if 'path '+rpath+' ' not in commands:
                subprocess.run(['install_name_tool', '-add_rpath', rpath, str(file)], check=True, capture_output=True)
            subprocess.run(['codesign', '--force', '--sign', '-', str(file)], check=True, capture_output=True)


def portable_linux(runtime):
    """Keep selected shared libraries next to the actual runtime, not build paths."""
    seen = set()
    for folder in ('lib', 'bin'):
        for candidate in sorted((runtime/folder).iterdir()):
            file = candidate.resolve()
            if not file.is_file() or file in seen or (folder == 'lib' and '.so' not in file.name):
                continue
            seen.add(file)
            subprocess.run(['patchelf', '--set-rpath', '$ORIGIN' if folder == 'lib' else '$ORIGIN/../lib', str(file)], check=True, capture_output=True)


def package(root, runtime, started, cmake, inventory_only):
    notices = [
      ('SCIP', root/PINS['scip'][2]/'LICENSE', 'Apache-2.0'),
      ('SoPlex', root/PINS['soplex'][2]/'LICENSE', 'Apache-2.0'),
      ('VIPR checker', root/PINS['vipr'][2]/'code/viprchk.cpp', 'MIT'),
      ('GMP', root/PINS['gmp'][2]/'COPYING.LESSERv3', 'LGPL-3.0-or-later'),
      ('GMP GPL companion', root/PINS['gmp'][2]/'COPYINGv3', 'GPL-3.0-or-later'),
      ('MPFR', root/PINS['mpfr'][2]/'COPYING.LESSER', 'LGPL-3.0-or-later'),
      ('MPFR GPL companion', root/PINS['mpfr'][2]/'COPYING', 'GPL-3.0-or-later'),
      ('Boost', root/PINS['boost'][2]/'LICENSE_1_0.txt', 'BSL-1.0'),
      ('CppAD bundled SCIP', root/PINS['scip'][2]/'src/cppad/COPYING', 'EPL-1.0'),
      ('TinyCThread bundled SCIP', root/PINS['scip'][2]/'src/tinycthread/COPYRIGHT', 'BSD-3-Clause'),
      ('fmt bundled SoPlex', root/PINS['soplex'][2]/'src/soplex/external/fmt/LICENSE.rst', 'MIT'),
      ('zstr bundled SoPlex', root/PINS['soplex'][2]/'src/soplex/external/zstr/License.txt', 'MIT')]
    directory = runtime/'licenses'
    directory.mkdir(parents=True, exist_ok=True)
    licenses = []
    for i, (component, source, license_id) in enumerate(notices):
        target = directory/(str(i)+'-'+component.replace(' ', '-')+'.txt')
        if component == 'VIPR checker':
            target.write_text(source.read_text().split('#include')[0])
        else:
            shutil.copyfile(source, target)
        licenses.append({'component': component, 'path': str(target.relative_to(runtime)), 'sha256': sha(target), 'license': license_id})
    files = [{'path': str(p.relative_to(runtime)), 'sha256': sha(p)} for folder in ('bin', 'lib') for p in sorted((runtime/folder).rglob('*'))
             if p.is_file() and (folder == 'bin' or p.suffix in ('.so', '.dylib') or '.so.' in p.name)]
    inventory = {'schema': 'finnor.r2.native-runtime.v1', 'scipCommit': PINS['scip'][2][5:], 'viprCommit': PINS['vipr'][2][5:],
                 'soplexCommit': PINS['soplex'][2][7:], 'configuration': {'exact': True, 'presolve': False, 'cuts': False, 'threads': 1},
                 'files': files, 'licenses': licenses, 'archives': {name: {'url': pin[0], 'sha256': pin[1]} for name, pin in PINS.items()},
                 'build': {'platform': platform.system(), 'architecture': platform.machine(), 'compiler': subprocess.check_output(['c++', '--version'], text=True).splitlines()[0],
                           'cmake': (json.loads((runtime/'manifest.json').read_text())['build']['cmake'] if inventory_only and not shutil.which(cmake) else subprocess.check_output([cmake, '--version'], text=True).splitlines()[0]), 'startedAt': started, 'finishedAt': None if inventory_only else timestamp(),
                           'inventoryAt': timestamp(), 'timingBasis': 'BUILD_TIMES_UNKNOWN_EXISTING_BYTES' if inventory_only else 'BUILDER_WALL_CLOCK',
                           'buildCpuMs': None, 'money': None, 'costStatus': 'UNMETERED'},
                 'custody': {'sourceArchives': 'Pinned URLs and exact archive digests above; retain build source/relinkable shared GNU libraries',
                            'systemZlib': 'Host/image system dependency; exact version and dependency linkage recorded in linked-libraries.txt',
                            'completion': 'Bounded Fraction weak-linear and single-z primal completion; unchanged native VIPR and original correspondence remain mandatory; arbitrary incomplete derivations refuse',
                            'relocation': 'macOS owned dependencies use @rpath and loader-relative paths; host system linkage is explicit'}}
    (runtime/'manifest.json').write_text(json.dumps(inventory, indent=2)+'\n')
    linkage = subprocess.check_output(['otool', '-L', str(runtime/'bin/scip')], text=True) if platform.system() == 'Darwin' else subprocess.check_output(['ldd', str(runtime/'bin/scip')], text=True)
    (runtime/'linked-libraries.txt').write_text(linkage)
    return inventory


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--build-root', required=True)
    parser.add_argument('--cmake', default='cmake')
    parser.add_argument('--package-existing', action='store_true')
    parser.add_argument('--started-at')
    args = parser.parse_args()
    root = Path(args.build_root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    runtime = root/'runtime'
    started = None if args.package_existing else timestamp()
    env = dict(os.environ, SOURCE_DATE_EPOCH='1760000000')

    def run(argv, cwd=root, log='build.log'):
        try:
            with (root/log).open('ab') as out:
                subprocess.run([str(a) for a in argv], cwd=cwd, env=env, stdout=out, stderr=subprocess.STDOUT, check=True, timeout=1800)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            # A Docker build cannot retain a failed intermediate layer. Surface
            # the actual bounded compiler/download diagnostic before refusing.
            with (root/log).open('rb') as diagnostic:
                diagnostic.seek(max(0, (root/log).stat().st_size-16384))
                print(diagnostic.read().decode(errors='replace'), flush=True)
            raise
    if not args.package_existing:
        for name, (url, expected, directory, extension) in PINS.items():
            archive = root/(name+'.tar.'+extension)
            if not archive.exists():
                run(['curl', '--fail', '--location', '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '20', '--max-time', '300', url, '--output', archive], log='downloads.log')
            if sha(archive) != expected:
                raise ValueError('Pinned archive digest mismatch: '+name)
            if not (root/directory).exists():
                run(['tar', '-xf', archive] + ([directory+'/boost', directory+'/LICENSE_1_0.txt'] if name == 'boost' else []), log='extract.log')
        for name in ('gmp', 'mpfr'):
            config = ['./configure', '--prefix='+str(runtime), '--disable-static'] + (['--enable-cxx'] if name == 'gmp' else ['--with-gmp='+str(runtime)])
            run(config, root/PINS[name][2], name+'-configure.log')
            run(['make', '-j2'], root/PINS[name][2], name+'-build.log')
            run(['make', 'install'], root/PINS[name][2], name+'-install.log')
        # Header-only Boost interface generated from the pinned 1.85 headers.
        # New CMake CMP0167 uses package config rather than FindBoost.
        boost = root/'boost-cmake'
        boost.mkdir(exist_ok=True)
        (boost/'BoostConfig.cmake').write_text('set(Boost_VERSION 108500)\nset(Boost_VERSION_STRING 1.85.0)\nset(Boost_INCLUDE_DIRS "${CMAKE_CURRENT_LIST_DIR}/../boost_1_85_0")\nset(Boost_FOUND TRUE)\nif(NOT TARGET Boost::boost)\nadd_library(Boost::boost INTERFACE IMPORTED)\nset_target_properties(Boost::boost PROPERTIES INTERFACE_INCLUDE_DIRECTORIES "${Boost_INCLUDE_DIRS}")\nendif()\n')
        (boost/'BoostConfigVersion.cmake').write_text('set(PACKAGE_VERSION 1.85.0)\nif(PACKAGE_FIND_VERSION VERSION_GREATER PACKAGE_VERSION)\nset(PACKAGE_VERSION_COMPATIBLE FALSE)\nelse()\nset(PACKAGE_VERSION_COMPATIBLE TRUE)\nendif()\n')
        common = ['-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_INSTALL_PREFIX='+str(runtime), '-DCMAKE_PREFIX_PATH='+str(runtime), '-DBoost_DIR='+str(boost), '-DGMP=ON', '-DMPFR=ON', '-DPAPILO=OFF']
        run([args.cmake, '-S', root/PINS['soplex'][2], '-B', root/'soplex-build']+common+['-DBOOST=ON'], log='soplex-configure.log')
        run([args.cmake, '--build', root/'soplex-build', '-j2'], log='soplex-build.log')
        run([args.cmake, '--install', root/'soplex-build'], log='soplex-install.log')
        run([args.cmake, '-S', root/PINS['scip'][2], '-B', root/'scip-build']+common+['-DSOPLEX_DIR='+str(root/'soplex-build'), '-DEXACTSOLVE=ON', '-DLPSEXACT=spx', '-DLPS=spx', '-DZIMPL=OFF', '-DAMPL=OFF', '-DIPOPT=OFF', '-DREADLINE=OFF', '-DSYM=none'], log='scip-configure.log')
        run([args.cmake, '--build', root/'scip-build', '--target', 'scip', '-j2'], log='scip-build.log')
        (runtime/'bin').mkdir(exist_ok=True)
        shutil.copy2(root/'scip-build/bin/scip', runtime/'bin/scip')
        vipr = root/'vipr-build'
        vipr.mkdir(exist_ok=True)
        (vipr/'CMakeConfig.hpp').write_text('#define VIPR_VERSION_MAJOR 1\n#define VIPR_VERSION_MINOR 1\n')
        run(['c++', '-std=c++14', '-O2', '-DNDEBUG', '-I'+str(vipr), '-I'+str(runtime/'include'), root/PINS['vipr'][2]/'code/viprchk.cpp',
             '-L'+str(runtime/'lib'), '-Wl,-rpath,'+str(runtime/'lib'), '-lgmpxx', '-lgmp', '-o', runtime/'bin/viprchk'], log='vipr-build.log')
    for name, pin in PINS.items():
        archive = root/(name+'.tar.'+pin[3])
        # Development's original gzip paths are retained, not silently replaced.
        if not archive.exists() and pin[3] == 'gz':
            archive = root/(name+'.tar.gz')
        if sha(archive) != pin[1]:
            raise ValueError('Source custody mismatch: '+name)
    if args.package_existing:
        # Inventory refresh requires only original notices, not a full rebuild.
        required = {'scip': ['LICENSE', 'src/cppad/COPYING', 'src/tinycthread/COPYRIGHT'],
                    'soplex': ['LICENSE', 'src/soplex/external/fmt/LICENSE.rst', 'src/soplex/external/zstr/License.txt'],
                    'vipr': ['code/viprchk.cpp'], 'gmp': ['COPYING.LESSERv3', 'COPYINGv3'],
                    'mpfr': ['COPYING.LESSER', 'COPYING'], 'boost': ['LICENSE_1_0.txt']}
        for name, members in required.items():
            pin = PINS[name]
            missing = [pin[2]+'/'+member for member in members if not (root/pin[2]/member).exists()]
            if missing:
                run(['tar', '-xf', root/(name+'.tar.'+pin[3]), *missing], log='extract-license.log')
    if not (root/PINS['boost'][2]/'LICENSE_1_0.txt').exists():
        run(['tar', '-xf', root/'boost.tar.bz2', PINS['boost'][2]+'/LICENSE_1_0.txt'], log='extract-license.log')
    if platform.system() == 'Darwin':
        portable_darwin(runtime)
    elif platform.system() == 'Linux':
        portable_linux(runtime)
    inventory = package(root, runtime, started, args.cmake, args.package_existing)
    print(json.dumps({'runtime': str(runtime), 'manifestSha256': sha(runtime/'manifest.json'), 'files': len(inventory['files']), 'licenses': len(inventory['licenses'])}))


if __name__ == '__main__':
    main()
