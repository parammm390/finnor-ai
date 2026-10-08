#import <Foundation/Foundation.h>
#import <Vision/Vision.h>
#import <ImageIO/ImageIO.h>
#import <sys/resource.h>
int main(void) { @autoreleasepool {
 NSTimeInterval started = [NSProcessInfo processInfo].systemUptime;
 NSData *bytes = [[NSFileHandle fileHandleWithStandardInput] readDataToEndOfFile];
 if (bytes.length > 6000000) return 2;
 CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)bytes, NULL);
 if (!source) return 3;
 CGImageRef image = CGImageSourceCreateImageAtIndex(source, 0, NULL); CFRelease(source);
 if (!image) return 4;
 size_t width = CGImageGetWidth(image), height = CGImageGetHeight(image);
 if (width > 8192 || height > 8192 || width * height > 16000000) { CGImageRelease(image); return 5; }
 VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
 request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
 request.recognitionLanguages = @[@"en-US"]; request.usesLanguageCorrection = NO;
 VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:image options:@{}];
 NSError *error = nil; BOOL success = [handler performRequests:@[request] error:&error];
 CGImageRelease(image); if (!success) return 6;
 NSMutableArray *lines = [NSMutableArray array];
 for (VNRecognizedTextObservation *observation in request.results) {
  VNRecognizedText *text = [[observation topCandidates:1] firstObject]; if (!text) continue;
  CGRect box = observation.boundingBox;
  [lines addObject:@{@"text": text.string, @"confidence": @(text.confidence), @"region": @[@(box.origin.x), @(1-box.origin.y-box.size.height), @(box.size.width), @(box.size.height)]}];
 }
 struct rusage usage; getrusage(RUSAGE_SELF, &usage);
 long long cpuMicros = usage.ru_utime.tv_sec*1000000LL+usage.ru_utime.tv_usec+usage.ru_stime.tv_sec*1000000LL+usage.ru_stime.tv_usec;
 NSDictionary *measured = @{@"wallMs":@(([NSProcessInfo processInfo].systemUptime-started)*1000),@"cpuMicros":@(cpuMicros),@"rusageMaxRSSRaw":@(usage.ru_maxrss),@"memoryScope":@"DARWIN_OCR_PROCESS_RUSAGE_RAW",@"inputBytes":@(bytes.length)};
 NSData *result = [NSJSONSerialization dataWithJSONObject:@{@"width":@(width),@"height":@(height),@"lines":lines,@"usage":measured} options:NSJSONWritingSortedKeys error:&error];
 if (!result) return 7; [[NSFileHandle fileHandleWithStandardOutput] writeData:result];
 return 0;
} }
