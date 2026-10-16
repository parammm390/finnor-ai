#lang rosette/safe

;; Trusted, fixed DSL only. JSON/host operations touch concrete transport data.
(require json rosette/solver/smt/z3
         (only-in racket/base getenv hash hash-ref for/list in-range
                  current-input-port current-output-port error newline))

(current-bitwidth #f)
(clear-vc!)
(define solver-path (getenv "FINNOR_R8_Z3"))
(unless solver-path (error 'r8 "Explicit pinned Z3 executable required"))
(current-solver (z3 #:path solver-path #:options (hash ':timeout 40000 ':random-seed 0)))
(define request (read-json (current-input-port)))
(define mode (hash-ref request 'operation))

(define (member? mask project)
  ;; Mask and project are concrete DSL structure. Never unlifted symbolic bit ops.
  (cond [(= project 0) (or (= mask 1) (= mask 3) (= mask 5) (= mask 7))]
        [(= project 1) (or (= mask 2) (= mask 3) (= mask 6) (= mask 7))]
        [else (>= mask 4)]))
(define (sum3 xs mask offset)
  (+ (if (member? mask 0) (list-ref xs offset) 0)
     (if (member? mask 1) (list-ref xs (+ offset 1)) 0)
     (if (member? mask 2) (list-ref xs (+ offset 2)) 0)))

(define (run xs enabled family net capacity inclusive better-equal descending)
  (define masks (if descending '(7 6 5 4 3 2 1) '(1 2 3 4 5 6 7)))
  (define (scan masks best-mask best-value)
    (if (null? masks) best-mask
        (let* ([mask (car masks)]
               [cost (if (= family 0) (sum3 xs mask 0) (sum3 xs mask 3))]
               [score (- (sum3 xs mask 3) (if net (sum3 xs mask 0) 0))]
               [allowed (and (list-ref enabled (- mask 1))
                             (if inclusive (<= cost capacity) (< cost capacity))
                             (if better-equal (>= score best-value) (> score best-value)))])
          (scan (cdr masks) (if allowed mask best-mask) (if allowed score best-value)))))
  (scan masks 0 0))

(define (expected xs)
  (define (scan masks best-mask best-value)
    (if (null? masks) best-mask
        (let* ([mask (car masks)] [cost (sum3 xs mask 0)] [value (sum3 xs mask 3)]
               [improves (and (<= cost 7) (> value best-value))])
          (scan (cdr masks) (if improves mask best-mask) (if improves value best-value)))))
  (scan '(1 2 3 4 5 6 7) 0 0))

(define result
  (if (equal? mode "SYNTHESIZE")
      (let ()
        (define-symbolic e1 e2 e3 e4 e5 e6 e7 net inclusive better-equal descending boolean?)
        (define-symbolic family capacity integer?)
        (define enabled (list e1 e2 e3 e4 e5 e6 e7))
        (define examples (hash-ref request 'examples))
        (define cap (hash-ref request 'enabledLimit))
        (define solution
          (synthesize
           #:forall '()
           #:guarantee
           (begin
             (assert (and (<= 0 family) (<= family 1) (<= 6 capacity) (<= capacity 8)))
             (assert (<= (+ (if e1 1 0) (if e2 1 0) (if e3 1 0) (if e4 1 0)
                            (if e5 1 0) (if e6 1 0) (if e7 1 0)) cap))
             (for-each (lambda (example)
                         (assert (= (run (hash-ref example 'input) enabled family net capacity
                                         inclusive better-equal descending)
                                    (hash-ref example 'mask))))
                       examples))))
        (cond [(sat? solution)
               (hash 'status "SAT"
                     'choices (hash 'enabled (evaluate enabled solution)
                                    'costFamily (evaluate family solution)
                                    'netScore (evaluate net solution)
                                    'capacity (evaluate capacity solution)
                                    'inclusiveFeasibility (evaluate inclusive solution)
                                    'inclusiveImprovement (evaluate better-equal solution)
                                    'descending (evaluate descending solution)))]
              [(unsat? solution) (hash 'status "UNSAT")]
              [else (hash 'status "UNKNOWN")]))
      (let ()
        (define c (hash-ref request 'choices))
        (define-symbolic c1 c2 c3 v1 v2 v3 integer?)
        (define xs (list c1 c2 c3 v1 v2 v3))
        (define solution
          (verify
           (begin
             (for-each (lambda (x) (assume (and (<= 0 x) (<= x 7)))) xs)
             (assert (= (run xs (hash-ref c 'enabled) (hash-ref c 'costFamily)
                             (hash-ref c 'netScore) (hash-ref c 'capacity)
                             (hash-ref c 'inclusiveFeasibility) (hash-ref c 'inclusiveImprovement)
                             (hash-ref c 'descending))
                        (expected xs))))))
        (cond [(sat? solution) (hash 'status "COUNTEREXAMPLE" 'input (evaluate xs solution))]
              [(unsat? solution) (hash 'status "UNSAT_ORIGINAL_D_NOT_ACCEPTANCE")]
              [else (hash 'status "UNKNOWN")]))))

(write-json result (current-output-port))
(newline)
(solver-shutdown (current-solver))
