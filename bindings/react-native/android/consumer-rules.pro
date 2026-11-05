# The core's Kotlin bindings reach it through JNA, which works by reflection, so R8 must keep JNA
# and the bindings. JNA's desktop parts reference AWT, which Android doesn't have.
-dontwarn java.awt.**
-keep class com.sun.jna.** { *; }
-keepclassmembers class * extends com.sun.jna.** { public *; }
-keep class de.schaefchens.shama.core.** { *; }
