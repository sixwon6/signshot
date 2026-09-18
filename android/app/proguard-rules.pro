# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

-keep class com.facebook.react.turbomodule.** { *; }

# Add any project specific keep options here:

# @generated begin expo-build-properties - expo prebuild (DO NOT MODIFY)
# Signshot — the native module's two reflective entry points; library consumer rules cover the rest.
-keep class expo.modules.seekercamera.SeekerCameraModule {
    public <init>();
    public expo.modules.kotlin.modules.ModuleDefinitionData definition();
}
-keep class expo.modules.seekercamera.SeekerCameraView {
    public <init>(android.content.Context, expo.modules.kotlin.AppContext);
}

# @generated end expo-build-properties