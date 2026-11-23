/* Read-only native facts. Qualification is derived by the separate JS bridge. */
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CommonCrypto/CommonDigest.h>
#import <Foundation/Foundation.h>
#include <arpa/inet.h>
#include <fcntl.h>
#include <libproc.h>
#include <mach/vm_prot.h>
#include <math.h>
#include <netinet/in.h>
#include <signal.h>
#include <string.h>
#include <sys/proc_info.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <unistd.h>

static const NSUInteger InputLimit = 65536;
static const NSUInteger OutputLimit = 131072;
static const unsigned long long ExecutableLimit = 536870912;

static void Require(BOOL ok, NSString *reason) {
    if (!ok) @throw [NSException exceptionWithName:@"FINNORBrowserObserverRefusal"
                                           reason:reason userInfo:nil];
}

static BOOL Hex64(id value) {
    if (![value isKindOfClass:[NSString class]] || [value length] != 64) return NO;
    NSCharacterSet *other = [[NSCharacterSet characterSetWithCharactersInString:
                             @"0123456789abcdef"] invertedSet];
    return [value rangeOfCharacterFromSet:other].location == NSNotFound;
}

static NSString *HexDigest(const unsigned char *bytes) {
    NSMutableString *result = [NSMutableString stringWithCapacity:64];
    for (NSUInteger i = 0; i < CC_SHA256_DIGEST_LENGTH; i++)
        [result appendFormat:@"%02x", bytes[i]];
    return result;
}

static NSString *StringDigest(NSString *value) {
    NSData *data = [value dataUsingEncoding:NSUTF8StringEncoding];
    unsigned char bytes[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(data.bytes, (CC_LONG)data.length, bytes);
    return HexDigest(bytes);
}

static BOOL SameStat(struct stat a, struct stat b) {
    return a.st_dev == b.st_dev && a.st_ino == b.st_ino
        && a.st_size == b.st_size && a.st_mode == b.st_mode && a.st_uid == b.st_uid
        && a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec
        && a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec
        && a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec
        && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec;
}

static void NoSymlinkAncestry(NSString *path) {
    Require([path isKindOfClass:[NSString class]] && [path hasPrefix:@"/"]
            && [path isEqualToString:path.stringByStandardizingPath],
            @"CANONICAL_ABSOLUTE_EXECUTABLE_REQUIRED");
    NSString *component = path;
    for (;;) {
        struct stat info;
        Require(lstat(component.fileSystemRepresentation, &info) == 0
                && !S_ISLNK(info.st_mode), @"EXECUTABLE_SYMLINK_OR_ABSENCE_REFUSED");
        if ([component isEqualToString:@"/"]) break;
        component = component.stringByDeletingLastPathComponent;
    }
}

static NSString *PinnedExecutable(NSDictionary *pin) {
    NSString *path = pin[@"path"];
    Require(Hex64(pin[@"sha256"]) && [pin[@"bytes"] isKindOfClass:[NSNumber class]]
            && [pin[@"mode"] isKindOfClass:[NSNumber class]],
            @"EXACT_BROWSER_EXECUTABLE_PIN_REQUIRED");
    NoSymlinkAncestry(path);
    int fd = open(path.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    Require(fd >= 0, @"BROWSER_EXECUTABLE_OPEN_REFUSED");
    @try {
        struct stat before, after, current;
        Require(fstat(fd, &before) == 0 && S_ISREG(before.st_mode)
                && before.st_size > 0 && (unsigned long long)before.st_size <= ExecutableLimit
                && (unsigned long long)before.st_size == [pin[@"bytes"] unsignedLongLongValue]
                && (before.st_mode & 07777) == [pin[@"mode"] unsignedIntValue]
                && (before.st_mode & 0022) == 0 && (before.st_mode & 0111) != 0
                && (before.st_uid == 0 || before.st_uid == getuid()),
                @"BROWSER_EXECUTABLE_METADATA_MISMATCH");
        CC_SHA256_CTX hash;
        CC_SHA256_Init(&hash);
        unsigned char buffer[262144], result[CC_SHA256_DIGEST_LENGTH];
        unsigned long long total = 0;
        for (;;) {
            ssize_t count = read(fd, buffer, sizeof buffer);
            Require(count >= 0, @"BROWSER_EXECUTABLE_READ_FAILED");
            if (count == 0) break;
            total += (unsigned long long)count;
            Require(total <= (unsigned long long)before.st_size,
                    @"BROWSER_EXECUTABLE_GREW");
            CC_SHA256_Update(&hash, buffer, (CC_LONG)count);
        }
        CC_SHA256_Final(result, &hash);
        Require(total == (unsigned long long)before.st_size
                && [HexDigest(result) isEqualToString:pin[@"sha256"]],
                @"BROWSER_EXECUTABLE_BYTES_MISMATCH");
        NoSymlinkAncestry(path);
        Require(fstat(fd, &after) == 0
                && lstat(path.fileSystemRepresentation, &current) == 0
                && SameStat(before, after) && SameStat(before, current),
                @"BROWSER_EXECUTABLE_CHANGED_DURING_READ");
    } @finally {
        close(fd);
    }
    return path;
}

static BOOL SameProcess(struct proc_bsdinfo a, struct proc_bsdinfo b) {
    return a.pbi_pid == b.pbi_pid && a.pbi_ppid == b.pbi_ppid
        && a.pbi_uid == b.pbi_uid && a.pbi_pgid == b.pbi_pgid
        && a.pbi_start_tvsec == b.pbi_start_tvsec
        && a.pbi_start_tvusec == b.pbi_start_tvusec;
}

static NSDictionary *Process(pid_t pid) {
    struct proc_bsdinfo before = {0}, after = {0};
    char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
    Require(pid > 0 && proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &before, sizeof before)
            == sizeof before && before.pbi_pid == (uint32_t)pid,
            @"KERNEL_PROCESS_IDENTITY_UNAVAILABLE");
    Require(proc_pidpath(pid, path, sizeof path) > 0,
            @"KERNEL_PROCESS_EXECUTABLE_UNAVAILABLE");
    Require(proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &after, sizeof after) == sizeof after
            && SameProcess(before, after), @"KERNEL_PROCESS_IDENTITY_CHANGED");
    NSString *executable = [NSString stringWithUTF8String:path];
    Require(executable != nil && before.pbi_start_tvsec > 0
            && before.pbi_start_tvusec < 1000000, @"KERNEL_BIRTH_UNAVAILABLE");
    return @{@"pid": @(pid), @"ppid": @(before.pbi_ppid), @"uid": @(before.pbi_uid),
             @"pgid": @(before.pbi_pgid),
             @"startSec": [NSString stringWithFormat:@"%llu", before.pbi_start_tvsec],
             @"startUsec": [NSString stringWithFormat:@"%llu", before.pbi_start_tvusec],
             @"executablePathSha256": StringDigest(executable)};
}

static NSArray *Lineage(pid_t pid) {
    NSMutableArray *result = [NSMutableArray array];
    NSMutableSet *seen = [NSMutableSet set];
    for (NSUInteger depth = 0; depth < 32; depth++) {
        Require(![seen containsObject:@(pid)], @"KERNEL_LINEAGE_CYCLE");
        [seen addObject:@(pid)];
        NSDictionary *row = Process(pid);
        [result addObject:row];
        if (pid == 1) {
            for (NSDictionary *earlier in result)
                Require([earlier isEqualToDictionary:Process([earlier[@"pid"] intValue])],
                        @"KERNEL_LINEAGE_CHANGED");
            return result;
        }
        pid = [row[@"ppid"] intValue];
        Require(pid > 0, @"COMPLETE_KERNEL_LINEAGE_REQUIRED");
    }
    Require(NO, @"KERNEL_LINEAGE_BOUND");
    return nil;
}

static NSDictionary *MappedExecutable(pid_t pid, NSString *path) {
    struct stat disk;
    NoSymlinkAncestry(path);
    Require(lstat(path.fileSystemRepresentation, &disk) == 0 && S_ISREG(disk.st_mode),
            @"ACTUAL_EXECUTABLE_VNODE_REQUIRED");
    uint64_t address = 0;
    for (NSUInteger count = 0; count < 64; count++) {
        struct proc_regionwithpathinfo region = {0};
        Require(proc_pidinfo(pid, PROC_PIDREGIONPATHINFO, address, &region, sizeof region)
                == sizeof region, @"KERNEL_MAPPED_EXECUTABLE_METADATA_UNAVAILABLE");
        size_t length = strnlen(region.prp_vip.vip_path, sizeof region.prp_vip.vip_path);
        Require(length < sizeof region.prp_vip.vip_path, @"KERNEL_MAPPED_PATH_BOUND");
        NSString *mapped = [[NSString alloc] initWithBytes:region.prp_vip.vip_path
                                                   length:length encoding:NSUTF8StringEncoding];
        if ((region.prp_prinfo.pri_protection & VM_PROT_EXECUTE)
            && [mapped isEqualToString:path]) {
            struct vinfo_stat node = region.prp_vip.vip_vi.vi_stat;
            Require(node.vst_dev == (uint32_t)disk.st_dev && node.vst_ino == disk.st_ino
                    && node.vst_size == disk.st_size && node.vst_mode == disk.st_mode
                    && node.vst_uid == disk.st_uid
                    && node.vst_mtime == disk.st_mtimespec.tv_sec
                    && node.vst_mtimensec == disk.st_mtimespec.tv_nsec
                    && node.vst_ctime == disk.st_ctimespec.tv_sec
                    && node.vst_ctimensec == disk.st_ctimespec.tv_nsec,
                    @"RUNNING_EXECUTABLE_AND_PINNED_FILE_VNODE_MISMATCH");
            return @{@"device": [NSString stringWithFormat:@"%u", node.vst_dev],
                     @"inode": [NSString stringWithFormat:@"%llu", node.vst_ino],
                     @"bytes": @(node.vst_size), @"mode": @(node.vst_mode & 07777),
                     @"uid": @(node.vst_uid),
                     @"mtimeSec": [NSString stringWithFormat:@"%lld", node.vst_mtime],
                     @"mtimeNsec": [NSString stringWithFormat:@"%lld", node.vst_mtimensec],
                     @"ctimeSec": [NSString stringWithFormat:@"%lld", node.vst_ctime],
                     @"ctimeNsec": [NSString stringWithFormat:@"%lld", node.vst_ctimensec]};
        }
        uint64_t next = region.prp_prinfo.pri_address + region.prp_prinfo.pri_size;
        Require(next > address && next > region.prp_prinfo.pri_address,
                @"KERNEL_REGION_PROGRESS_REQUIRED");
        address = next;
    }
    Require(NO, @"KERNEL_EXECUTABLE_REGION_POPULATION_BOUND");
    return nil;
}

static NSDictionary *ListenerAtFD(pid_t pid, int fd, unsigned int port) {
    struct socket_fdinfo info = {0};
    if (proc_pidfdinfo(pid, fd, PROC_PIDFDSOCKETINFO, &info, sizeof info) != sizeof info)
        return nil;
    struct socket_info socket = info.psi;
    struct tcp_sockinfo tcp = socket.soi_proto.pri_tcp;
    if (socket.soi_kind != SOCKINFO_TCP || socket.soi_family != AF_INET
        || socket.soi_type != SOCK_STREAM || socket.soi_protocol != IPPROTO_TCP
        || tcp.tcpsi_state != TSI_S_LISTEN || !(tcp.tcpsi_ini.insi_vflag & INI_IPV4)
        || ntohs((uint16_t)tcp.tcpsi_ini.insi_lport) != port
        || tcp.tcpsi_ini.insi_laddr.ina_46.i46a_addr4.s_addr != htonl(INADDR_LOOPBACK))
        return nil;
    Require(tcp.tcpsi_ini.insi_gencnt > 0, @"KERNEL_LISTENER_GENERATION_UNAVAILABLE");
    return @{@"pid": @(pid), @"fd": @(fd),
             @"portSha256": StringDigest([NSString stringWithFormat:@"%u", port]),
             @"addressClass": @"EXACT_IPV4_LOOPBACK", @"state": @"LISTEN",
             @"generation": [NSString stringWithFormat:@"%llu", tcp.tcpsi_ini.insi_gencnt]};
}

static NSDictionary *OwnedListener(pid_t pid, unsigned int port) {
    struct proc_fdinfo entries[8192];
    int needed = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, NULL, 0);
    Require(needed > 0 && needed < (int)sizeof entries, @"BOUNDED_BROWSER_FD_POPULATION_REQUIRED");
    int bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, entries, (int)sizeof entries);
    Require(bytes > 0 && bytes < (int)sizeof entries && bytes % (int)sizeof(struct proc_fdinfo) == 0,
            @"ACTUAL_COMPLETE_BROWSER_FD_METADATA_REQUIRED");
    NSDictionary *selected = nil;
    NSUInteger count = (NSUInteger)bytes / sizeof(struct proc_fdinfo);
    for (NSUInteger i = 0; i < count; i++) {
        if (entries[i].proc_fdtype != PROX_FDTYPE_SOCKET) continue;
        NSDictionary *listener = ListenerAtFD(pid, entries[i].proc_fd, port);
        if (!listener) continue;
        Require(selected == nil, @"UNIQUE_ASSIGNED_BROWSER_LISTENER_REQUIRED");
        selected = listener;
    }
    if (selected)
        Require([selected isEqualToDictionary:ListenerAtFD(pid, [selected[@"fd"] intValue], port)],
                @"KERNEL_LISTENER_CHANGED_DURING_SAMPLE");
    return selected;
}

static NSString *BootDigest(void) {
    char value[128] = {0};
    size_t size = sizeof value;
    Require(sysctlbyname("kern.bootsessionuuid", value, &size, NULL, 0) == 0
            && size > 1 && size < sizeof value, @"KERNEL_BOOT_IDENTITY_UNAVAILABLE");
    NSString *uuid = [NSString stringWithUTF8String:value];
    Require(uuid.length == 36, @"KERNEL_BOOT_IDENTITY_INVALID");
    return StringDigest(uuid);
}

static BOOL EligibleWindow(NSDictionary *window, CGDirectDisplayID *displays,
                           uint32_t displayCount) {
    id rawBounds = window[(id)kCGWindowBounds];
    double alpha = [window[(id)kCGWindowAlpha] doubleValue];
    if (![window[(id)kCGWindowIsOnscreen] boolValue]
        || [window[(id)kCGWindowLayer] intValue] != 0
        || !isfinite(alpha) || alpha < 0.95 || alpha > 1
        || ![rawBounds isKindOfClass:[NSDictionary class]]) return NO;
    CGRect bounds;
    if (!CGRectMakeWithDictionaryRepresentation(
            (__bridge CFDictionaryRef)rawBounds, &bounds)
        || CGRectIsNull(bounds) || CGRectIsInfinite(bounds)
        || !isfinite(bounds.origin.x) || !isfinite(bounds.origin.y)
        || !isfinite(bounds.size.width) || !isfinite(bounds.size.height)
        || bounds.size.width < 100 || bounds.size.height < 50) return NO;
    for (uint32_t i = 0; i < displayCount; i++)
        if (!CGRectIsEmpty(CGRectIntersection(bounds, CGDisplayBounds(displays[i]))))
            return YES;
    return NO;
}

static NSDictionary *Observe(NSDictionary *request) {
    Require(getuid() == geteuid() && getppid() == [request[@"requesterPid"] intValue],
            @"ACTUAL_UNPRIVILEGED_REQUESTER_REQUIRED");
    NSString *phase = request[@"phase"], *bundleId = request[@"bundleIdentifier"];
    Require([phase isEqualToString:@"baseline"] || [phase isEqualToString:@"challenge"],
            @"EXACT_NATIVE_OBSERVATION_PHASE_REQUIRED");
    Require([@[@"com.google.Chrome", @"org.chromium.Chromium"] containsObject:bundleId],
            @"SUPPORTED_EXTERNAL_BROWSER_PROFILE_REQUIRED");
    id rawPort = request[@"assignedPort"];
    unsigned int assignedPort = [rawPort unsignedIntValue];
    Require([rawPort isKindOfClass:[NSNumber class]] && [rawPort doubleValue] == assignedPort
            && assignedPort >= 1024 && assignedPort <= 65535,
            @"EXACT_ASSIGNED_DIRECT_LOOPBACK_PORT_REQUIRED");
    BOOL challenge = [phase isEqualToString:@"challenge"];
    Require(!challenge || Hex64(request[@"nonce"]), @"EXACT_CHALLENGE_NONCE_REQUIRED");
    NSString *token = challenge ? [@"finnor-w2-observer-" stringByAppendingString:request[@"nonce"]] : nil;
    NSString *boot = BootDigest();
    double startedAt = NSDate.date.timeIntervalSince1970 * 1000;
    NSArray *requesterLineage = Lineage(getppid());
    NSString *executable = PinnedExecutable(request[@"executable"]);
    Require(CGPreflightScreenCaptureAccess(), @"EXISTING_WINDOW_TITLE_PERMISSION_REQUIRED");
    CGDirectDisplayID displays[16];
    uint32_t displayCount = 0;
    Require(CGGetActiveDisplayList(16, displays, &displayCount) == kCGErrorSuccess
            && displayCount > 0 && displayCount < 16, @"BOUNDED_ACTIVE_DISPLAY_FACTS_REQUIRED");
    CFArrayRef raw = CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
    Require(raw != NULL, @"ACTUAL_ONSCREEN_WINDOW_LIST_REQUIRED");
    NSArray *windows = CFBridgingRelease(raw);
    Require(windows.count <= 4096, @"NATIVE_WINDOW_POPULATION_BOUND");
    NSArray *apps = NSWorkspace.sharedWorkspace.runningApplications;
    Require(apps.count <= 512, @"NATIVE_APPLICATION_POPULATION_BOUND");
    NSMutableArray *processes = [NSMutableArray array];
    for (NSRunningApplication *app in apps) {
        if (![app.bundleIdentifier isEqualToString:bundleId] || app.terminated || app.hidden
            || !app.finishedLaunching || app.activationPolicy != NSApplicationActivationPolicyRegular)
            continue;
        pid_t pid = app.processIdentifier;
        BOOL requesterAncestor = NO;
        for (NSDictionary *ancestor in requesterLineage)
            if ([ancestor[@"pid"] intValue] == pid) requesterAncestor = YES;
        if (requesterAncestor) continue;
        if (![app.executableURL.path isEqualToString:executable]
            || !app.bundleURL.isFileURL) continue;
        NSBundle *bundle = [NSBundle bundleWithURL:app.bundleURL];
        Require([bundle.bundleIdentifier isEqualToString:bundleId]
                && [[bundle objectForInfoDictionaryKey:@"CFBundlePackageType"] isEqual:@"APPL"]
                && [bundle.executableURL.path isEqualToString:executable],
                @"ACTUAL_MAIN_BROWSER_APPLICATION_REQUIRED");
        NSArray *lineage = Lineage(pid);
        NSDictionary *process = lineage.firstObject;
        Require([process[@"uid"] unsignedIntValue] == getuid()
                && [process[@"executablePathSha256"] isEqual:StringDigest(executable)],
                @"ACTUAL_BROWSER_PROCESS_EXECUTABLE_MISMATCH");
        NSDictionary *mapping = MappedExecutable(pid, executable);
        NSDictionary *listener = OwnedListener(pid, assignedPort);
        if (!listener) continue;
        NSDate *launchDate = app.launchDate;
        NSMutableArray *selected = [NSMutableArray array];
        for (NSDictionary *window in windows) {
            if ([window[(id)kCGWindowOwnerPID] intValue] != pid
                || !EligibleWindow(window, displays, displayCount)) continue;
            NSString *name = window[(id)kCGWindowName];
            if (challenge && (![name isKindOfClass:[NSString class]]
                || [name rangeOfString:token].location == NSNotFound)) continue;
            [selected addObject:@{@"id": window[(id)kCGWindowNumber],
                                  @"ownerPid": @(pid), @"onScreen": @YES, @"layer": @0,
                                  @"alpha": window[(id)kCGWindowAlpha],
                                  @"intersectsActiveDisplay": @YES,
                                  @"titleMetadataAvailable": @([name isKindOfClass:[NSString class]])}];
        }
        if (selected.count == 0) continue;
        NSRunningApplication *again = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
        Require(again && [app isEqual:again] && !again.terminated && !again.hidden
                && [again.executableURL.path isEqualToString:executable]
                && [again.bundleIdentifier isEqualToString:bundleId]
                && ((launchDate == nil && again.launchDate == nil)
                    || [launchDate isEqualToDate:again.launchDate])
                && [mapping isEqualToDictionary:MappedExecutable(pid, executable)]
                && [listener isEqualToDictionary:OwnedListener(pid, assignedPort)]
                && [lineage isEqualToArray:Lineage(pid)],
                @"BROWSER_APPLICATION_CHANGED_DURING_OBSERVATION");
        NSMutableDictionary *row = [process mutableCopy];
        row[@"lineage"] = lineage;
        row[@"bundleIdentifier"] = bundleId;
        row[@"executableSha256"] = request[@"executable"][@"sha256"];
        row[@"mappedExecutable"] = mapping;
        row[@"endpointListener"] = listener;
        row[@"appLaunchUnixMs"] = launchDate ? @(launchDate.timeIntervalSince1970 * 1000) : NSNull.null;
        row[@"windows"] = selected;
        [processes addObject:row];
        Require(processes.count <= 8, @"BROWSER_PROCESS_POPULATION_BOUND");
    }
    Require([boot isEqualToString:BootDigest()]
            && [requesterLineage isEqualToArray:Lineage(getppid())]
            && [executable isEqualToString:PinnedExecutable(request[@"executable"])],
            @"NATIVE_OBSERVATION_POPULATION_CHANGED");
    NSMutableDictionary *result = [@{@"schema": @"finnor.w2.browser-owner-native-facts.v1",
                                    @"status": @"OBSERVED", @"phase": phase,
                                    @"startedAtUnixMs": @(startedAt),
                                    @"observedAtUnixMs": @(NSDate.date.timeIntervalSince1970 * 1000),
                                    @"bootSha256": boot, @"requester": requesterLineage.firstObject,
                                    @"requesterLineage": requesterLineage,
                                    @"processes": processes} mutableCopy];
    if (challenge) result[@"nonceSha256"] = StringDigest(request[@"nonce"]);
    return result;
}

static void Emit(NSDictionary *result) {
    NSData *bytes = [NSJSONSerialization dataWithJSONObject:result options:0 error:NULL];
    Require(bytes && bytes.length < OutputLimit, @"NATIVE_JSON_OUTPUT_BOUND");
    const unsigned char *cursor = bytes.bytes;
    NSUInteger left = bytes.length;
    while (left > 0) {
        ssize_t count = write(STDOUT_FILENO, cursor, left);
        Require(count > 0, @"NATIVE_JSON_OUTPUT_FAILED");
        cursor += count;
        left -= (NSUInteger)count;
    }
    Require(write(STDOUT_FILENO, "\n", 1) == 1, @"NATIVE_JSON_OUTPUT_FAILED");
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        alarm(8);
        @try {
            Require(argc == 1, @"NATIVE_STDIN_REQUEST_ONLY");
            NSMutableData *bytes = [NSMutableData data];
            unsigned char buffer[4096];
            for (;;) {
                ssize_t count = read(STDIN_FILENO, buffer, sizeof buffer);
                Require(count >= 0, @"NATIVE_STDIN_READ_FAILED");
                if (count == 0) break;
                Require(bytes.length + (NSUInteger)count <= InputLimit, @"NATIVE_STDIN_BOUND");
                [bytes appendBytes:buffer length:(NSUInteger)count];
            }
            id request = [NSJSONSerialization JSONObjectWithData:bytes options:0 error:NULL];
            Require([request isKindOfClass:[NSDictionary class]], @"EXACT_NATIVE_JSON_REQUEST_REQUIRED");
            Emit(Observe(request));
            return 0;
        } @catch (NSException *exception) {
            NSString *reason = [exception.name isEqualToString:@"FINNORBrowserObserverRefusal"]
                ? exception.reason : @"NATIVE_OBSERVATION_REFUSED";
            @try {
                Emit(@{@"schema": @"finnor.w2.browser-owner-native-facts.v1",
                       @"status": @"UNKNOWN", @"reason": reason});
            } @catch (__unused NSException *ignored) {}
            return 2;
        }
    }
}
