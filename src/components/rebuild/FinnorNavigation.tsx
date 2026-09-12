"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { siteConfig } from "@/config/site";

import { FinnorMark } from "./FinnorMark";
import styles from "./FinnorNavigation.module.css";

const navigationItems = [
  { label: "Product", href: "/product" },
  { label: "Capabilities", href: "/capabilities" },
  { label: "How it works", href: "/how-it-works" },
  { label: "Resources", href: "/resources" },
  { label: "Trust", href: "/trust-safety" },
  { label: "Pricing", href: "/pricing" },
  { label: "FAQ", href: "/faq" },
] as const;

export default function FinnorNavigation({ tone = "light" }: { tone?: "light" | "dark" }) {
  const pathname = usePathname();
  const isNavigationItemActive = (href: string) => pathname === href || Boolean(pathname?.startsWith(`${href}/`));
  const [isOpen, setIsOpen] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);
  const [scrollProgress, setScrollProgress] = useState(0);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const firstDrawerLinkRef = useRef<HTMLAnchorElement>(null);
  const drawerId = `finnor-navigation-drawer-${useId().replace(/:/g, "")}`;
  const reducedMotion = useReducedMotion();

  const closeDrawer = useCallback(() => {
    setIsOpen(false);
    menuButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    let frame = 0;

    const updateScrollState = () => {
      if (frame) return;

      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const scrollableHeight = Math.max(document.documentElement.scrollHeight - window.innerHeight, 0);
        const nextProgress = scrollableHeight > 0 ? window.scrollY / scrollableHeight : 0;

        setIsScrolled(window.scrollY > 12);
        setScrollProgress(Math.min(1, Math.max(0, nextProgress)));
      });
    };

    updateScrollState();
    window.addEventListener("scroll", updateScrollState, { passive: true });
    window.addEventListener("resize", updateScrollState);

    return () => {
      window.removeEventListener("scroll", updateScrollState);
      window.removeEventListener("resize", updateScrollState);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    const focusFrame = window.requestAnimationFrame(() => {
      firstDrawerLinkRef.current?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeDrawer();
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeDrawer, isOpen]);

  const drawerTransition = reducedMotion ? { duration: 0 } : { duration: 0.26, ease: "easeOut" as const };
  const progressTransition = reducedMotion ? { duration: 0 } : { duration: 0.12, ease: "linear" as const };

  return (
    <header className={styles.navigation} data-scrolled={isScrolled} data-tone={tone}>
      <div className={styles.rail}>
        <Link className={styles.wordmark} href="/" aria-label="FINNOR home">
          <span className={styles.wordmarkMark}><FinnorMark className={styles.markSvg} /></span>
          <span className={styles.wordmarkText}>FINNOR</span>
          <span className={styles.wordmarkMeta}>PRIVATE EQUITY · DECISION + EXECUTION</span>
        </Link>

        <nav className={styles.desktopNav} aria-label="Primary navigation">
          {navigationItems.map((item) => (
            <Link
              className={styles.navLink}
              href={item.href}
              key={item.href}
              data-active={isNavigationItemActive(item.href)}
              aria-current={isNavigationItemActive(item.href) ? "page" : undefined}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className={styles.utilityNav}>
          <Link className={styles.signIn} href="/jarvis/login">
            <span className={styles.stateDot} aria-hidden="true" />JARVIS sign in
          </Link>
          <a className={styles.primaryAction} href={siteConfig.calendlyLink} target="_blank" rel="noreferrer">
            <span>Plan your deployment</span>
            <span className={styles.actionArrow} aria-hidden="true">
              ↗
            </span>
          </a>
        </div>

        <Link className={styles.mobileStatus} href="/jarvis/login" aria-label="Open JARVIS sign in">
          <span className={styles.stateDot} aria-hidden="true" />
          <span>JARVIS</span>
          <span className={styles.mobileStatusValue}>READY</span>
        </Link>

        <button
          ref={menuButtonRef}
          className={styles.menuButton}
          type="button"
          aria-label={isOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={isOpen}
          aria-controls={drawerId}
          onClick={() => (isOpen ? closeDrawer() : setIsOpen(true))}
        >
          <span className={`${styles.menuGlyph} ${isOpen ? styles.menuGlyphOpen : ""}`} aria-hidden="true">
            <span />
            <span />
          </span>
        </button>
      </div>

      <div className={styles.progressTrack} aria-hidden="true">
        <motion.span
          className={styles.progressValue}
          style={{ width: `${scrollProgress * 100}%` }}
          transition={progressTransition}
        />
      </div>

      <div className={styles.drawerRegion} id={drawerId} data-open={isOpen} aria-hidden={!isOpen}>
        <AnimatePresence initial={false}>
          {isOpen ? (
            <motion.nav
              className={styles.drawerPanel}
              aria-label="Mobile navigation"
              initial={reducedMotion ? false : { opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -10 }}
              transition={drawerTransition}
            >
              <div className={styles.drawerInner}>
                <div className={styles.drawerContext}>
                  <span className={styles.drawerContextRule} aria-hidden="true" />
                  <span>FINNOR / PRIVATE EQUITY INFRASTRUCTURE</span>
                </div>

                <ul className={styles.drawerList}>
                  {navigationItems.map((item, index) => (
                    <li className={styles.drawerItem} key={item.href}>
                      <Link
                        ref={index === 0 ? firstDrawerLinkRef : undefined}
                        className={styles.drawerLink}
                        href={item.href}
                        data-active={isNavigationItemActive(item.href)}
                        aria-current={isNavigationItemActive(item.href) ? "page" : undefined}
                        onClick={closeDrawer}
                      >
                        <span>{item.label}</span>
                        <span className={styles.linkArrow} aria-hidden="true" />
                      </Link>
                    </li>
                  ))}
                </ul>

                <div className={styles.drawerActions}>
                  <Link className={styles.drawerSignIn} href="/jarvis/login" onClick={closeDrawer}>
                    JARVIS sign in
                  </Link>
                  <a
                    className={`${styles.primaryAction} ${styles.drawerPrimaryAction}`}
                    href={siteConfig.calendlyLink}
                    target="_blank"
                    rel="noreferrer"
                    onClick={closeDrawer}
                  >
                    <span>Plan your deployment</span>
                    <span className={styles.actionArrow} aria-hidden="true">
                      ↗
                    </span>
                  </a>
                </div>
              </div>
            </motion.nav>
          ) : null}
        </AnimatePresence>
      </div>
    </header>
  );
}
