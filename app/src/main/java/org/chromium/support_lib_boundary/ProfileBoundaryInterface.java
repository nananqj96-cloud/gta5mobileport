package org.chromium.support_lib_boundary;

import java.util.Set;

/**
 * Minimal Chromium WebView Support Library boundary interface matching
 * ProfileBoundaryInterface.java (Chromium WebView v150+ / AndroidX WebKit 1.18.0).
 */
public interface ProfileBoundaryInterface {
    String getName();

    void setCrossOriginIsolatedAllowList(Set<String> originPatterns);

    Set<String> getCrossOriginIsolatedAllowList();

    void configureIsolatedSites(Set<String> sites);

    boolean canConfigureIsolatedSites();
}
