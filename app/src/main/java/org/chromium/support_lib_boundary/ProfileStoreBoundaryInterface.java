package org.chromium.support_lib_boundary;

import java.lang.reflect.InvocationHandler;
import java.util.List;

/**
 * Minimal Chromium WebView Support Library boundary interface matching
 * ProfileStoreBoundaryInterface.java.
 */
public interface ProfileStoreBoundaryInterface {
    /* ProfileBoundaryInterface */
    InvocationHandler getOrCreateProfile(String name);

    /* ProfileBoundaryInterface */
    InvocationHandler getProfile(String name);

    List<String> getAllProfileNames();
}
