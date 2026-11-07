plugins {
    id("com.android.application")
}

android {
    namespace = "app.aitradingterminal"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.aitradingterminal"
        minSdk = 26
        targetSdk = 35
        versionCode = 47
        versionName = "0.7.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
}


dependencies {
    testImplementation("junit:junit:4.13.2")
}
